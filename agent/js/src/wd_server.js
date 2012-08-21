/******************************************************************************
Copyright (c) 2012, Google Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of Google, Inc. nor the names of its contributors
      may be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
******************************************************************************/
/*jslint nomen:false */

var child_process = require('child_process');
var devtools = require('devtools');
var devtools_network = require('devtools_network');
var devtools_page = require('devtools_page');
var devtools_timeline = require('devtools_timeline');
var events = require('events');
var util = require('util');
var wd_sandbox = require('wd_sandbox');
var webdriver = require('webdriver');
var vm = require('vm');

var WD_CONNECT_TIMEOUT_MS_ = 40000;
var DEVTOOLS_CONNECT_TIMEOUT_MS_ = 10000;
var WAIT_AFTER_ONLOAD_MS_ = 10000;

var webDriverServer;
process.on('message', function(m) {
  if (m.cmd === 'init') {
    WebDriverServer.init(m.options, m.script, m.javaCommand, 
      m.jarPath, m.chromeDriver);
  } else if (m.cmd === 'connect') {
    WebDriverServer.connect();
  } else if (m.cmd === 'stop') {
    WebDriverServer.stop();
  }
});

/**
 * Responsible for a WebDriver server for a given browser type.
 *
 * @param options A dictionary:
 *     browserName -- Selenium name of the browser.
 *     browserVersion -- Selenium version of the browser.
 */
var WebDriverServer = {

  init: function(options, script, javaCommand, jarPath, chromeDriver) {
    'use strict'
    this.javaCommand_ = javaCommand || 'java';
    this.serverJar_ = jarPath;
    this.chromeDriver_ = chromeDriver;
    this.options_ = options || {};
    this.script_ = script;
    this.serverProcess_ = undefined;
    this.serverUrl_ = undefined;
    this.driver_ = undefined;
    this.devToolsPort_ = 1234;
    this.devToolsMessages_ = [];
    this.devToolsTimelineMessages_ = [];

    this.uncaughtExceptionHandler_ = this.onUncaughtException_.bind(this);
  },

  onUncaughtException_: function(e) {
    'use strict'
    console.error('Stopping WebDriver server on uncaught exception: %s', e);
    process.send({cmd: 'error', e: e});
    this.stop();
  },

  /** Returns a closure that returns the server URL. */
  startServer_: function() {
    'use strict'
    var self = this;
    if (!this.serverJar_) {
      throw new Error('Must set server jar before starting WebDriver server');
    }
    if (this.serverProcess_) {
      console.log('WARNING: prior WD server unexpectedly ' +
                  'alive when launching');
      this.serverProcess_.kill();
      this.serverProcess_ = undefined;
      this.serverUrl_ = undefined;
    }
    var javaArgs = [
      '-Dwebdriver.chrome.driver=' + this.chromeDriver_,
      '-jar', this.serverJar_
    ];
    console.log('Starting WD server: %s %s',
        this.javaCommand_, javaArgs.join(' '));
    var serverProcess = child_process.spawn(this.javaCommand_, javaArgs);
    serverProcess.on('exit', function(code, signal) {
      console.log('WD EXIT code %s, signal %s', code, signal);
      self.serverProcess_ = undefined;
      self.serverUrl_ = undefined;
      process.send({cmd: 'exit', code: code, signal: signal});
    });
    serverProcess.stdout.on('data', function(data) {
      //console.log('WD STDOUT: %s', data);
    });
    serverProcess.stderr.on('data', function(data) {
      //console.log('WD STDERR: %s', data);
    });
    this.serverProcess_ = serverProcess;
    this.serverUrl_ = 'http://localhost:4444/wd/hub';

    // Create an executor to simplify querying the server to see if it is ready.
    var client = new webdriver.node.HttpClient(this.serverUrl_);
    var executor = new webdriver.http.Executor(client);
    var command = 
        new webdriver.Command(webdriver.CommandName.GET_SERVER_STATUS);
    var wdApp = webdriver.promise.Application.getInstance();
    wdApp.scheduleWait('Waiting for WD server to be ready', function() {
      var isReady = new webdriver.promise.Deferred();
      executor.execute(command, function(error /*, unused_response*/) {
        if (error) {
          isReady.resolve(false);
        } else {
          isReady.resolve(true);
        }
      });
      return isReady.promise;
    }, WD_CONNECT_TIMEOUT_MS_);
  },

  onDriverBuild_: function(driver, browserCaps, wdNamespace) {
    'use strict'
    var self = this;
    console.log('WD post-build callback, driver=%s', JSON.stringify(driver));
    self.driver_ = driver;
    if (browserCaps.browserName.indexOf('chrome') !== -1) {
      self.connectDevTools_(wdNamespace);
    }
  },

  connectDevTools_: function(wdNamespace) {
    'use strict'
    var self = this;
    var wdApp = wdNamespace.promise.Application.getInstance();
    wdApp.scheduleWait('Connect DevTools', function() {
      var isDevtoolsConnected = new wdNamespace.promise.Deferred();
      var devTools = new devtools.DevTools(
          'http://localhost:' + self.devToolsPort_ + '/json');
      devTools.on('connect', function() {
        var networkTools = new devtools_network.Network(devTools);
        var pageTools = new devtools_page.Page(devTools);
        var timelineTools = new devtools_timeline.Timeline(devTools);
        networkTools.enable(function() {
          console.log('DevTools Network events enabled');
        });
        pageTools.enable(function() {
          console.log('DevTools Page events enabled');
        });
        timelineTools.enable(function() {
          console.log('DevTools Timeline events enabled');
        });
        timelineTools.start(function() {
          console.log('DevTools Timeline events started');
        });
        isDevtoolsConnected.resolve(true);
      });
      devTools.on('message', function(message) {
         self.onDevToolsMessage_(message);
      });
      devTools.connect();
      return isDevtoolsConnected.promise;
    }, DEVTOOLS_CONNECT_TIMEOUT_MS_);
  },

  /**
   * Creates a sandbox (map) in which to run a user script.
   *
   * @param seeds a map of additional stuff to put in the sandbox.
   * @return a map to use as the sandbox for the vm API.
   */
  createSandbox_: function(seeds) {
    'use strict'
    var sandbox = {
      console: console,
      setTimeout: global.setTimeout
    };
    for (var property in seeds) {
      if (seeds.hasOwnProperty(property)) {
        console.log('Copying seed property into sandbox: %s', property);
        sandbox[property] = seeds[property];
      }
    }
    return sandbox;
  },

  connect: function() {
    'use strict'
    var self = this;
    this.startServer_();  // TODO(klm): Handle process failure
    process.once('uncaughtException', this.uncaughtExceptionHandler_);
    var browserCaps = {
      browserName: (this.options_.browserName || 'chrome').toLowerCase(),
      version: this.options_.browserVersion || '',
      platform: 'ANY',
      javascriptEnabled: true,
      // Only used when launching actual Chrome, ignored otherwise
      'chrome.switches': ['-remote-debugging-port=' + this.devToolsPort_]
    };
    console.log('browserCaps = %s', JSON.stringify(browserCaps));
    var mainWdApp = webdriver.promise.Application.getInstance();
    mainWdApp.schedule('Run sandboxed WD session', function() {
      return wd_sandbox.createSandboxedWdNamespace(
          self.serverUrl_, browserCaps, function(driver, wdSandbox) {
            self.onDriverBuild_(driver, browserCaps, wdSandbox);
          }).then(function(wdSandbox) {
            console.log('Sandboxed WD module created');
            var sandboxWdApp = wdSandbox.promise.Application.getInstance();
            sandboxWdApp.on(wdSandbox.promise.Application.EventType.IDLE, 
                function() {
              console.log('The sandbox application has gone idle, history: %s',
              sandboxWdApp.getHistory());
            });
            // Bring it!
            return sandboxWdApp.schedule('Run Script', function() {
            console.log('Running script');
            self.runScript_(self.script_, wdSandbox);
          }).then(self.waitForCoalesce(sandboxWdApp, WAIT_AFTER_ONLOAD_MS_));
      });
    }).then(function() {
      self.done_();
    }, function(e) {
      self.onError_(e);
    });

    mainWdApp.on(webdriver.promise.Application.EventType.IDLE, function() {
      console.log('The main application has gone idle, history: %s',
          mainWdApp.getHistory());
    });

    console.log('WD connect promise setup complete');
  },

  runScript_: function(script, wdSandbox) {
    'use strict'
    var sandbox = this.createSandbox_({
      webdriver: wdSandbox
    });
    vm.runInNewContext(script, sandbox, 'WPT Job Script');
  },

  waitForCoalesce: function(sandboxWdApp, timeout) {
    'use strict'
    console.log('Sandbox finished, waiting for browser to coalesce');
    sandboxWdApp.scheduleTimeout(
        'Wait to let the browser coalesce', timeout);
  },

  done_: function() {
    'use strict'
    var self = this;
    var mainWdApp = webdriver.promise.Application.getInstance();
    console.log('Sandboxed session succeeded');
    this.stop();
    mainWdApp.schedule('Emit done', function() {
      process.send({
          cmd: 'done',
          devToolsMessages: self.devToolsMessages_,
          devToolsTimelineMessages: self.devToolsTimelineMessages_});
    });
  },

  onError_: function(e) {
    'use strict'
    console.log('Sandboxed session failed, calling server stop(): %s', e.stack);
    this.stop();
    process.send({cmd: 'error', e: e});
  },

  onDevToolsMessage_: function(message) {
    'use strict'
    console.log('DevTools message: %s', JSON.stringify(message));
    if ('method' in message) {
      if (message.method.slice(0, devtools_network.METHOD_PREFIX.length) ===
          devtools_network.METHOD_PREFIX
          || message.method.slice(0, devtools_page.METHOD_PREFIX.length) ===
          devtools_page.METHOD_PREFIX) {
        this.devToolsMessages_.push(message);
      } else {
        this.devToolsTimelineMessages_.push(message)
      }
    }
  },

  stop: function() {
    'use strict'
    var self = this;
    // Stop handling uncaught exceptions
    process.removeListener('uncaughtException', this.uncaughtExceptionHandler_);
    var killProcess = function() {
      if (self.serverProcess_) {
        try {
          self.killServerProcess();
        } catch (killException) {
          console.error('WebDriver server kill failed: %s', killException);
        }
      } else {
        console.error('stop(): server process is already unset');
      }
      // Unconditionally unset them, even if the scheduled quit/kill fails
      self.driver_ = undefined;
      self.serverUrl_ = undefined;
    }
    var driver = this.driver_;  // For closure -- this.driver_ would be reset
    if (driver) {
      console.info('stop(): driver.quit()');
      driver.quit().then(killProcess, killProcess);


    } else {
      console.error('stop(): driver is already unset');
      killProcess();
    }
  },

  killServerProcess: function() {
    'use strict'
    this.serverProcess_.kill('SIGHUP');
  }
}
exports.WebDriverServer = WebDriverServer;
