const mdns = require('mdns');
const CastClient = require('castv2-client').Client;
const CastDefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
const debug = require('debug');

const pkginfo = require('./package');
const InitCustomCharacteristics = require('./custom-characteristics');

let Service;
let Characteristic;

const mdnsSequence = [
  mdns.rst.DNSServiceResolve(),
  'DNSServiceGetAddrInfo' in mdns.dns_sd ? mdns.rst.DNSServiceGetAddrInfo() : mdns.rst.getaddrinfo({ families: [0] }),
  mdns.rst.makeAddressesUnique(),
];

class AutomationChromecast {
  constructor(log, config) {
    this.log = log;
    this.name = config.name;
    this.chromecastDeviceName = config.chromecastDeviceName;
    this.switchOffDelay = config.switchOffDelay || 0;
    this.debug = debug(`homebridge-automation-chromecast:${this.chromecastDeviceName}`);

    const CustomCharacteristics = InitCustomCharacteristics(Characteristic);

    this.setDefaultProperties(true);

    this.switchService = new Service.Switch(this.name);
    this.switchService
      .getCharacteristic(Characteristic.On)
      .on('get', this.isCasting.bind(this))
      .on('set', this.setCasting.bind(this));

    this.switchService
      .addCharacteristic(CustomCharacteristics.DeviceType)
      .on('get', callback => callback(null, this.deviceType));

    this.switchService
      .addCharacteristic(CustomCharacteristics.DeviceIp)
      .on('get', callback => callback(null, `${this.chromecastIp}:${this.chromecastPort}`));

    this.switchService
      .addCharacteristic(CustomCharacteristics.DeviceId)
      .on('get', callback => callback(null, this.deviceId));

    this.switchService
      .addCharacteristic(Characteristic.Volume)
      .on('get', callback => callback(null, Math.floor(this.volume * 100)))
      .on('set', this.setVolume.bind(this));

    this.motionService = new Service.MotionSensor(`${this.name} Streaming`);

    this.motionService
      .getCharacteristic(Characteristic.MotionDetected)
      .on('get', this.isCasting.bind(this));

    this.accessoryInformationService = new Service.AccessoryInformation();

    this.accessoryInformationService
      .setCharacteristic(Characteristic.Name, this.name)
      .setCharacteristic(Characteristic.Manufacturer, pkginfo.author.name || pkginfo.author)
      .setCharacteristic(Characteristic.Model, pkginfo.name)
      .setCharacteristic(Characteristic.SerialNumber, 'n/a')
      .setCharacteristic(Characteristic.FirmwareRevision, pkginfo.version)
      .setCharacteristic(Characteristic.HardwareRevision, pkginfo.version);

    this.detectChromecast();
  }

  setDefaultProperties(resetIpAndPort = false, stopReconnecting = false) {
    if (resetIpAndPort) {
      this.chromecastIp = null;
      this.chromecastPort = null;
    }

    this.resetClient();

    this.isCastingStatus = false;
    this.castingApplication = null;
    this.castingMedia = null;
    this.volume = 0;

    this.deviceType = null;
    this.deviceId = null;

    this.switchOffDelayTimer = null;

    if (stopReconnecting) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }
    }
    this.reconnectTimer = null;

    if (!this.reconnectCounter) {
      this.reconnectCounter = 0;
    }
  }

  /**
   * Use bonjour to detect Chromecast devices on the network
   */
  detectChromecast() {
    const browser = mdns.createBrowser(mdns.tcp('googlecast'), { resolverSequence: mdnsSequence });

    browser.on('serviceUp', (device) => {
      const txt = device.txtRecord;
      const name = txt.fn;

      if (name.toLowerCase() === this.chromecastDeviceName.toLowerCase()) {
        this.setDefaultProperties(true, true);

        const ipAddress = device.addresses[0];
        const { port } = device;

        this.chromecastIp = ipAddress;
        this.chromecastPort = port;

        this.deviceType = txt.md || '';
        this.deviceId = txt.id;

        this.log(`Chromecast found on ${this.chromecastIp}:${this.chromecastPort}`);

        this.clientConnect();
      }
    });

    // Restart browser every 30 minutes or so to make sure we are listening to announcements
    setTimeout(() => {
      browser.stop();

      this.clientDisconnect(false);
      this.debug('detectChromecast() - Restarting mdns browser');
      this.detectChromecast();
    }, 30 * 60 * 1000);

    this.log(`Searching for Chromecast device named "${this.chromecastDeviceName}"`);
    browser.start();
  }

  clientError(error) {
    this.log(`Chromecast client error - ${error}`);

    this.clientDisconnect(true);
  }

  resetClient() {
    if (this.chromecastClient) {
      try {
        this.chromecastClient.close();
      } catch (e) { // eslint-disable-line
      }
    } else {
      this.chromecastClient = null;
    }
  }

  clientDisconnect(reconnect) {
    this.log('Chromecast connection: disconnected');

    this.setIsCasting(false);
    this.setDefaultProperties(false, true);

    if (reconnect) {
      if (this.reconnectCounter > 150) { // Backoff after 5 minutes
        this.log('Chromecast reconnection: backoff, searching again for Chromecast');
        this.detectChromecast();
        return;
      }

      this.log('Waiting 2 seconds before reconnecting');

      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectCounter = this.reconnectCounter + 1;
        this.clientConnect();
      }, 2000);
    }
  }

  clientConnect() {
    this.chromecastClient = new CastClient();

    const connectionDetails = {
      host: this.chromecastIp,
      port: this.chromecastPort,
    };

    this.chromecastClient
      .on('status', this.processClientStatus.bind(this))
      .on('timeout', () => this.debug('chromeCastClient - timeout'))
      .on('error', status => this.clientError(status));

    this.log(`Connecting to Chromecast on ${this.chromecastIp}:${this.chromecastPort}`);

    this.chromecastClient.connect(connectionDetails, () => {
      if (
        this.chromecastClient &&
        this.chromecastClient.connection &&
        this.chromecastClient.heartbeat &&
        this.chromecastClient.receiver
      ) {
        this.reconnectCounter = 0;
        this.log('Chromecast connection: connected');

        this.chromecastClient.connection
          .on('timeout', () => this.debug('chromeCastClient.connection - timeout'))
          .on('disconnect', () => this.clientDisconnect(true));

        this.chromecastClient.heartbeat
          .on('timeout', () => this.debug('chromeCastClient.heartbeat - timeout'))
          .on('pong', () => null);

        this.chromecastClient.receiver
          .on('status', this.processClientStatus.bind(this));

        // Force to detect the current status in order to initialise processClientStatus() at boot
        this.chromecastClient.getStatus((err, status) => this.processClientStatus(status));
      }
    });
  }

  processClientStatus(status) {
    this.debug('processClientStatus() - Received client status', status);

    const { applications } = status;
    const currentApplication = applications && applications.length > 0 ? applications[0] : null;

    if (currentApplication) {
      const lastMonitoredApplicationStatusId =
        this.castingApplication ? this.castingApplication.sessionId : null;

      if (currentApplication.sessionId !== lastMonitoredApplicationStatusId) {
        this.castingApplication = currentApplication;

        /*
        NOTE: The castv2-client library has not been updated in a while.
        The current version of Chromecast protocol may NOT include transportId when streaming
        to a group of speakers. The transportId is same as the sessionId.
        Assigning the transportId to the sessionId makes the library works with
        group of speakers in Chromecast Audio.
         */
        this.castingApplication.transportId = this.castingApplication.sessionId;

        try {
          this.chromecastClient.join(
            this.castingApplication,
            CastDefaultMediaReceiver,
            (_, media) => {
              this.debug('processClientStatus() - New media');
              // Force to detect the current status in order to initialise at boot
              media.getStatus((err, mediaStatus) => this.processMediaStatus(mediaStatus));
              media.on('status', this.processMediaStatus.bind(this));
              this.castingMedia = media;
            },
          );
        } catch (e) {
          // Handle exceptions like "Cannot read property 'createChannel' of null"
          this.debug('processClientStatus() - Exception', e);
          this.clientDisconnect(true);
        }
      }
    } else {
      this.castingMedia = null;
      this.debug('processClientStatus() - Reset media');
    }

    // Process "Stop casting" command
    if (typeof status.applications === 'undefined') {
      this.debug('processClientStatus() - Stopped casting');
      this.setIsCasting(false);
    }

    // Process volume
    if (status.volume && 'level' in status.volume) {
      this.volume = status.volume.level;
    }
  }

  processMediaStatus(status) {
    this.debug('processMediaStatus() - Received media status', status);

    if (status && status.playerState) {
      if (status.playerState === 'PLAYING' || status.playerState === 'BUFFERING') {
        this.setIsCasting(true);
      } else {
        this.setIsCasting(false);
      }
    }
  }

  setIsCasting(statusBool) {
    // Update the internal state and log only if there's been a change of state
    if (statusBool !== this.isCastingStatus) {
      if (statusBool) {
        this.log('Chromecast is now playing');
        this.isCastingStatus = true;
      } else {
        this.log('Chromecast is now stopped');
        this.isCastingStatus = false;
      }

      this.switchService.setCharacteristic(Characteristic.On, this.isCastingStatus);

      const updateMotionSensor = () => {
        this.motionService.setCharacteristic(Characteristic.MotionDetected, this.isCastingStatus);
        this.log(`Motion sensor ${this.isCastingStatus ? 'is detecting movements' : 'stopped detecting movements'}`);
      };

      if (!this.isCastingStatus && this.switchOffDelay) {
        this.switchOffDelayTimer = setTimeout(updateMotionSensor, this.switchOffDelay);
      } else {
        if (this.switchOffDelayTimer) {
          clearTimeout(this.switchOffDelayTimer);
        }
        updateMotionSensor();
      }
    }
  }

  getServices() {
    return [
      this.switchService,
      this.motionService,
      this.accessoryInformationService,
    ];
  }

  /**
   * Is the Chromecast currently receiving an audio/video stream?
   *
   * @param {function} callback
   */
  isCasting(callback) {
    callback(null, this.isCastingStatus);
  }

  /**
   * Set the Chromecast volume
   *
   * @param {int} volume
   * @param {function} callback
   */
  setVolume(volume, callback) {
    const currentValue = this.volume;

    this.debug(`setVolume() - Current status: ${currentValue} - New status: ${volume}`);

    if (this.chromecastClient) {
      try {
        this.chromecastClient.setVolume({ level: volume / 100 }, () => callback());
      } catch (e) {
        this.debug('setVolume() - Reported error', e);
        callback();
      }
    }
  }

  /**
   * Start/stop the Chromecast from receiving an audio/video stream
   *
   * @param {boolean} on
   * @param {function} callback
   */
  setCasting(on, callback) {
    const currentlyCasting = this.isCastingStatus;
    this.setIsCasting(on);

    this.debug(`setCasting() - Current status: ${currentlyCasting} - New status: ${on}`);

    if (!this.castingMedia) {
      callback();
      return;
    }

    if (on && !currentlyCasting) {
      this.debug('setCasting() - Play');
      this.castingMedia.play(() => null);
    } else if (!on && currentlyCasting) {
      this.debug('setCasting() - Pause');
      this.castingMedia.pause(() => null);
    }
    callback();
  }
}

module.exports = (homebridge) => {
  Service = homebridge.hap.Service; // eslint-disable-line
  Characteristic = homebridge.hap.Characteristic; // eslint-disable-line

  homebridge.registerAccessory('homebridge-automation-chromecast', 'AutomationChromecast', AutomationChromecast);
};
