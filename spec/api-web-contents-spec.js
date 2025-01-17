'use strict'

const ChildProcess = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { closeWindow } = require('./window-helpers')
const { emittedOnce } = require('./events-helpers')
const chai = require('chai')
const dirtyChai = require('dirty-chai')

const features = process.electronBinding('features')
const { ipcRenderer, remote, clipboard } = require('electron')
const { BrowserWindow, webContents, ipcMain, session } = remote
const { expect } = chai

const isCi = remote.getGlobal('isCi')

chai.use(dirtyChai)

/* The whole webContents API doesn't use standard callbacks */
/* eslint-disable standard/no-callback-literal */

describe('webContents module', () => {
  const fixtures = path.resolve(__dirname, 'fixtures')
  let w

  beforeEach(() => {
    w = new BrowserWindow({
      show: false,
      width: 400,
      height: 400,
      webPreferences: {
        backgroundThrottling: false,
        nodeIntegration: true,
        webviewTag: true
      }
    })
  })

  afterEach(() => closeWindow(w).then(() => { w = null }))

  describe('loadURL() promise API', () => {
    it('resolves when done loading', async () => {
      await expect(w.loadURL('about:blank')).to.eventually.be.fulfilled
    })

    it('resolves when done loading a file URL', async () => {
      await expect(w.loadFile(path.join(fixtures, 'pages', 'base-page.html'))).to.eventually.be.fulfilled
    })

    it('rejects when failing to load a file URL', async () => {
      await expect(w.loadURL('file:non-existent')).to.eventually.be.rejected
        .and.have.property('code', 'ERR_FILE_NOT_FOUND')
    })

    it('rejects when loading fails due to DNS not resolved', async () => {
      await expect(w.loadURL('https://err.name.not.resolved')).to.eventually.be.rejected
        .and.have.property('code', 'ERR_NAME_NOT_RESOLVED')
    })

    it('rejects when navigation is cancelled due to a bad scheme', async () => {
      await expect(w.loadURL('bad-scheme://foo')).to.eventually.be.rejected
        .and.have.property('code', 'ERR_FAILED')
    })

    it('sets appropriate error information on rejection', async () => {
      let err
      try {
        await w.loadURL('file:non-existent')
      } catch (e) {
        err = e
      }
      expect(err).not.to.be.null()
      expect(err.code).to.eql('ERR_FILE_NOT_FOUND')
      expect(err.errno).to.eql(-6)
      expect(err.url).to.eql(process.platform === 'win32' ? 'file://non-existent/' : 'file:///non-existent')
    })

    it('rejects if the load is aborted', async () => {
      const s = http.createServer((req, res) => { /* never complete the request */ })
      await new Promise(resolve => s.listen(0, '127.0.0.1', resolve))
      const { port } = s.address()
      const p = expect(w.loadURL(`http://127.0.0.1:${port}`)).to.eventually.be.rejectedWith(Error, /ERR_ABORTED/)
      // load a different file before the first load completes, causing the
      // first load to be aborted.
      await w.loadFile(path.join(fixtures, 'pages', 'base-page.html'))
      await p
      s.close()
    })

    it("doesn't reject when a subframe fails to load", async () => {
      let resp = null
      const s = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.write('<iframe src="http://err.name.not.resolved"></iframe>')
        resp = res
        // don't end the response yet
      })
      await new Promise(resolve => s.listen(0, '127.0.0.1', resolve))
      const { port } = s.address()
      const p = new Promise(resolve => {
        w.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame, frameProcessId, frameRoutingId) => {
          if (!isMainFrame) {
            resolve()
          }
        })
      })
      const main = w.loadURL(`http://127.0.0.1:${port}`)
      await p
      resp.end()
      await main
      s.close()
    })

    it("doesn't resolve when a subframe loads", async () => {
      let resp = null
      const s = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.write('<iframe src="data:text/html,hi"></iframe>')
        resp = res
        // don't end the response yet
      })
      await new Promise(resolve => s.listen(0, '127.0.0.1', resolve))
      const { port } = s.address()
      const p = new Promise(resolve => {
        w.webContents.on('did-frame-finish-load', (event, errorCode, errorDescription, validatedURL, isMainFrame, frameProcessId, frameRoutingId) => {
          if (!isMainFrame) {
            resolve()
          }
        })
      })
      const main = w.loadURL(`http://127.0.0.1:${port}`)
      await p
      resp.destroy() // cause the main request to fail
      await expect(main).to.eventually.be.rejected
        .and.have.property('errno', -355) // ERR_INCOMPLETE_CHUNKED_ENCODING
      s.close()
    })
  })

  describe('getFocusedWebContents() API', () => {
    it('returns the focused web contents', (done) => {
      if (isCi) return done()

      const specWebContents = remote.getCurrentWebContents()
      expect(specWebContents.id).to.equal(webContents.getFocusedWebContents().id)

      specWebContents.once('devtools-opened', () => {
        expect(specWebContents.devToolsWebContents.id).to.equal(webContents.getFocusedWebContents().id)
        specWebContents.closeDevTools()
      })

      specWebContents.once('devtools-closed', () => {
        expect(specWebContents.id).to.equal(webContents.getFocusedWebContents().id)
        done()
      })

      specWebContents.openDevTools()
    })

    it('does not crash when called on a detached dev tools window', (done) => {
      const specWebContents = w.webContents

      specWebContents.once('devtools-opened', () => {
        expect(() => {
          webContents.getFocusedWebContents()
        }).to.not.throw()
        specWebContents.closeDevTools()
      })

      specWebContents.once('devtools-closed', () => {
        expect(() => {
          webContents.getFocusedWebContents()
        }).to.not.throw()
        done()
      })

      specWebContents.openDevTools({ mode: 'detach' })
      w.inspectElement(100, 100)
    })
  })

  describe('setDevToolsWebContents() API', () => {
    it('sets arbitrary webContents as devtools', async () => {
      const devtools = new BrowserWindow({ show: false })
      const promise = emittedOnce(devtools.webContents, 'dom-ready')
      w.webContents.setDevToolsWebContents(devtools.webContents)
      w.webContents.openDevTools()
      await promise
      expect(devtools.getURL().startsWith('devtools://devtools')).to.be.true()
      const result = await devtools.webContents.executeJavaScript('InspectorFrontendHost.constructor.name')
      expect(result).to.equal('InspectorFrontendHostImpl')
      devtools.destroy()
    })
  })

  describe('isFocused() API', () => {
    it('returns false when the window is hidden', () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        expect(!window.isVisible() && window.webContents.isFocused()).to.be.false()
      })
    })
  })

  describe('isCurrentlyAudible() API', () => {
    it('returns whether audio is playing', async () => {
      const webContents = remote.getCurrentWebContents()
      const context = new window.AudioContext()
      // Start in suspended state, because of the
      // new web audio api policy.
      context.suspend()
      const oscillator = context.createOscillator()
      oscillator.connect(context.destination)
      oscillator.start()
      let p = emittedOnce(webContents, '-audio-state-changed')
      await context.resume()
      await p
      expect(webContents.isCurrentlyAudible()).to.be.true()
      p = emittedOnce(webContents, '-audio-state-changed')
      oscillator.stop()
      await p
      expect(webContents.isCurrentlyAudible()).to.be.false()
      oscillator.disconnect()
      context.close()
    })
  })

  describe('getWebPreferences() API', () => {
    it('should not crash when called for devTools webContents', (done) => {
      w.webContents.openDevTools()
      w.webContents.once('devtools-opened', () => {
        expect(w.devToolsWebContents.getWebPreferences()).to.be.null()
        done()
      })
    })
  })

  describe('openDevTools() API', () => {
    it('can show window with activation', async () => {
      const focused = emittedOnce(w, 'focus')
      w.show()
      await focused
      expect(w.isFocused()).to.be.true()
      const devtoolsOpened = emittedOnce(w.webContents, 'devtools-opened')
      w.webContents.openDevTools({ mode: 'detach', activate: true })
      await devtoolsOpened
      expect(w.isFocused()).to.be.false()
    })

    it('can show window without activation', async () => {
      const devtoolsOpened = emittedOnce(w.webContents, 'devtools-opened')
      w.webContents.openDevTools({ mode: 'detach', activate: false })
      await devtoolsOpened
      expect(w.isDevToolsOpened()).to.be.true()
    })
  })

  describe('before-input-event event', () => {
    it('can prevent document keyboard events', async () => {
      await w.loadFile(path.join(fixtures, 'pages', 'key-events.html'))
      const keyDown = new Promise(resolve => {
        ipcMain.once('keydown', (event, key) => resolve(key))
      })
      ipcRenderer.sendSync('prevent-next-input-event', 'a', w.webContents.id)
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a' })
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'b' })
      expect(await keyDown).to.equal('b')
    })

    it('has the correct properties', async () => {
      await w.loadFile(path.join(fixtures, 'pages', 'base-page.html'))
      const testBeforeInput = async (opts) => {
        const modifiers = []
        if (opts.shift) modifiers.push('shift')
        if (opts.control) modifiers.push('control')
        if (opts.alt) modifiers.push('alt')
        if (opts.meta) modifiers.push('meta')
        if (opts.isAutoRepeat) modifiers.push('isAutoRepeat')

        const p = emittedOnce(w.webContents, 'before-input-event')
        w.webContents.sendInputEvent({
          type: opts.type,
          keyCode: opts.keyCode,
          modifiers: modifiers
        })
        const [, input] = await p

        expect(input.type).to.equal(opts.type)
        expect(input.key).to.equal(opts.key)
        expect(input.code).to.equal(opts.code)
        expect(input.isAutoRepeat).to.equal(opts.isAutoRepeat)
        expect(input.shift).to.equal(opts.shift)
        expect(input.control).to.equal(opts.control)
        expect(input.alt).to.equal(opts.alt)
        expect(input.meta).to.equal(opts.meta)
      }
      await testBeforeInput({
        type: 'keyDown',
        key: 'A',
        code: 'KeyA',
        keyCode: 'a',
        shift: true,
        control: true,
        alt: true,
        meta: true,
        isAutoRepeat: true
      })
      await testBeforeInput({
        type: 'keyUp',
        key: '.',
        code: 'Period',
        keyCode: '.',
        shift: false,
        control: true,
        alt: true,
        meta: false,
        isAutoRepeat: false
      })
      await testBeforeInput({
        type: 'keyUp',
        key: '!',
        code: 'Digit1',
        keyCode: '1',
        shift: true,
        control: false,
        alt: false,
        meta: true,
        isAutoRepeat: false
      })
      await testBeforeInput({
        type: 'keyUp',
        key: 'Tab',
        code: 'Tab',
        keyCode: 'Tab',
        shift: false,
        control: true,
        alt: false,
        meta: false,
        isAutoRepeat: true
      })
    })
  })

  describe('zoom-changed', () => {
    beforeEach(function () {
      // On Mac, zooming isn't done with the mouse wheel.
      if (process.platform === 'darwin') {
        return closeWindow(w).then(() => {
          w = null
          this.skip()
        })
      }
    })

    it('is emitted with the correct zooming info', async () => {
      w.loadFile(path.join(fixtures, 'pages', 'base-page.html'))
      await emittedOnce(w.webContents, 'did-finish-load')

      const testZoomChanged = async ({ zoomingIn }) => {
        const promise = emittedOnce(w.webContents, 'zoom-changed')

        w.webContents.sendInputEvent({
          type: 'mousewheel',
          x: 300,
          y: 300,
          deltaX: 0,
          deltaY: zoomingIn ? 1 : -1,
          wheelTicksX: 0,
          wheelTicksY: zoomingIn ? 1 : -1,
          phase: 'began',
          modifiers: ['control', 'meta']
        })

        const [, zoomDirection] = await promise
        expect(zoomDirection).to.equal(zoomingIn ? 'in' : 'out')
      }

      await testZoomChanged({ zoomingIn: true })
      await testZoomChanged({ zoomingIn: false })
    })
  })

  describe('devtools window', () => {
    let testFn = it
    if (process.platform === 'darwin' && isCi) {
      testFn = it.skip
    }
    if (process.platform === 'win32' && isCi) {
      testFn = it.skip
    }
    try {
      // We have other tests that check if native modules work, if we fail to require
      // robotjs let's skip this test to avoid false negatives
      require('robotjs')
    } catch (err) {
      testFn = it.skip
    }

    testFn('can receive and handle menu events', async function () {
      this.timeout(5000)
      w.show()
      w.loadFile(path.join(fixtures, 'pages', 'key-events.html'))
      // Ensure the devtools are loaded
      w.webContents.closeDevTools()
      const opened = emittedOnce(w.webContents, 'devtools-opened')
      w.webContents.openDevTools()
      await opened
      await emittedOnce(w.webContents.devToolsWebContents, 'did-finish-load')
      w.webContents.devToolsWebContents.focus()

      // Focus an input field
      await w.webContents.devToolsWebContents.executeJavaScript(
        `const input = document.createElement('input');
        document.body.innerHTML = '';
        document.body.appendChild(input)
        input.focus();`
      )

      // Write something to the clipboard
      clipboard.writeText('test value')

      // Fake a paste request using robotjs to emulate a REAL keyboard paste event
      require('robotjs').keyTap('v', process.platform === 'darwin' ? ['command'] : ['control'])

      const start = Date.now()
      let val

      // Check every now and again for the pasted value (paste is async)
      while (val !== 'test value' && Date.now() - start <= 1000) {
        val = await w.webContents.devToolsWebContents.executeJavaScript(
          `document.querySelector('input').value`
        )
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      // Once we're done expect the paste to have been successful
      expect(val).to.equal('test value', 'value should eventually become the pasted value')
    })
  })

  describe('sendInputEvent(event)', () => {
    beforeEach(async () => {
      await w.loadFile(path.join(fixtures, 'pages', 'key-events.html'))
    })

    it('can send keydown events', (done) => {
      ipcMain.once('keydown', (event, key, code, keyCode, shiftKey, ctrlKey, altKey) => {
        expect(key).to.equal('a')
        expect(code).to.equal('KeyA')
        expect(keyCode).to.equal(65)
        expect(shiftKey).to.be.false()
        expect(ctrlKey).to.be.false()
        expect(altKey).to.be.false()
        done()
      })
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
    })

    it('can send keydown events with modifiers', (done) => {
      ipcMain.once('keydown', (event, key, code, keyCode, shiftKey, ctrlKey, altKey) => {
        expect(key).to.equal('Z')
        expect(code).to.equal('KeyZ')
        expect(keyCode).to.equal(90)
        expect(shiftKey).to.be.true()
        expect(ctrlKey).to.be.true()
        expect(altKey).to.be.false()
        done()
      })
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['shift', 'ctrl'] })
    })

    it('can send keydown events with special keys', (done) => {
      ipcMain.once('keydown', (event, key, code, keyCode, shiftKey, ctrlKey, altKey) => {
        expect(key).to.equal('Tab')
        expect(code).to.equal('Tab')
        expect(keyCode).to.equal(9)
        expect(shiftKey).to.be.false()
        expect(ctrlKey).to.be.false()
        expect(altKey).to.be.true()
        done()
      })
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['alt'] })
    })

    it('can send char events', (done) => {
      ipcMain.once('keypress', (event, key, code, keyCode, shiftKey, ctrlKey, altKey) => {
        expect(key).to.equal('a')
        expect(code).to.equal('KeyA')
        expect(keyCode).to.equal(65)
        expect(shiftKey).to.be.false()
        expect(ctrlKey).to.be.false()
        expect(altKey).to.be.false()
        done()
      })
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A' })
      w.webContents.sendInputEvent({ type: 'char', keyCode: 'A' })
    })

    it('can send char events with modifiers', (done) => {
      ipcMain.once('keypress', (event, key, code, keyCode, shiftKey, ctrlKey, altKey) => {
        expect(key).to.equal('Z')
        expect(code).to.equal('KeyZ')
        expect(keyCode).to.equal(90)
        expect(shiftKey).to.be.true()
        expect(ctrlKey).to.be.true()
        expect(altKey).to.be.false()
        done()
      })
      w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z' })
      w.webContents.sendInputEvent({ type: 'char', keyCode: 'Z', modifiers: ['shift', 'ctrl'] })
    })
  })

  it('supports inserting CSS', async () => {
    w.loadURL('about:blank')
    await w.webContents.insertCSS('body { background-repeat: round; }')
    const result = await w.webContents.executeJavaScript('window.getComputedStyle(document.body).getPropertyValue("background-repeat")')
    expect(result).to.equal('round')
  })

  it('supports removing inserted CSS', async () => {
    w.loadURL('about:blank')
    const key = await w.webContents.insertCSS('body { background-repeat: round; }')
    await w.webContents.removeInsertedCSS(key)
    const result = await w.webContents.executeJavaScript('window.getComputedStyle(document.body).getPropertyValue("background-repeat")')
    expect(result).to.equal('repeat')
  })

  it('supports inspecting an element in the devtools', (done) => {
    w.loadURL('about:blank')
    w.webContents.once('devtools-opened', () => { done() })
    w.webContents.inspectElement(10, 10)
  })

  describe('startDrag({file, icon})', () => {
    it('throws errors for a missing file or a missing/empty icon', () => {
      expect(() => {
        w.webContents.startDrag({ icon: path.join(fixtures, 'assets', 'logo.png') })
      }).to.throw(`Must specify either 'file' or 'files' option`)

      expect(() => {
        w.webContents.startDrag({ file: __filename })
      }).to.throw(`Must specify 'icon' option`)

      if (process.platform === 'darwin') {
        expect(() => {
          w.webContents.startDrag({ file: __filename, icon: __filename })
        }).to.throw(`Must specify non-empty 'icon' option`)
      }
    })
  })

  describe('focus()', () => {
    describe('when the web contents is hidden', () => {
      it('does not blur the focused window', (done) => {
        ipcMain.once('answer', (event, parentFocused, childFocused) => {
          expect(parentFocused).to.be.true()
          expect(childFocused).to.be.false()
          done()
        })
        w.show()
        w.loadFile(path.join(fixtures, 'pages', 'focus-web-contents.html'))
      })
    })
  })

  describe('getOSProcessId()', () => {
    it('returns a valid procress id', async () => {
      expect(w.webContents.getOSProcessId()).to.equal(0)

      await w.loadURL('about:blank')
      expect(w.webContents.getOSProcessId()).to.be.above(0)
    })
  })

  describe('zoom api', () => {
    const zoomScheme = remote.getGlobal('zoomScheme')
    const hostZoomMap = {
      host1: 0.3,
      host2: 0.7,
      host3: 0.2
    }

    before((done) => {
      const protocol = session.defaultSession.protocol
      protocol.registerStringProtocol(zoomScheme, (request, callback) => {
        const response = `<script>
                            const {ipcRenderer, remote} = require('electron')
                            ipcRenderer.send('set-zoom', window.location.hostname)
                            ipcRenderer.on(window.location.hostname + '-zoom-set', () => {
                              const { zoomLevel } = remote.getCurrentWebContents()
                              ipcRenderer.send(window.location.hostname + '-zoom-level', zoomLevel)
                            })
                          </script>`
        callback({ data: response, mimeType: 'text/html' })
      }, (error) => done(error))
    })

    after((done) => {
      const protocol = session.defaultSession.protocol
      protocol.unregisterProtocol(zoomScheme, (error) => done(error))
    })

    // TODO(codebytere): remove in Electron v8.0.0
    it('can set the correct zoom level (functions)', async () => {
      try {
        await w.loadURL('about:blank')
        const zoomLevel = w.webContents.getZoomLevel()
        expect(zoomLevel).to.eql(0.0)
        w.webContents.setZoomLevel(0.5)
        const newZoomLevel = w.webContents.getZoomLevel()
        expect(newZoomLevel).to.eql(0.5)
      } finally {
        w.webContents.setZoomLevel(0)
      }
    })

    it('can set the correct zoom level', async () => {
      try {
        await w.loadURL('about:blank')
        const zoomLevel = w.webContents.zoomLevel
        expect(zoomLevel).to.eql(0.0)
        w.webContents.zoomLevel = 0.5
        const newZoomLevel = w.webContents.zoomLevel
        expect(newZoomLevel).to.eql(0.5)
      } finally {
        w.webContents.zoomLevel = 0
      }
    })

    it('can persist zoom level across navigation', (done) => {
      let finalNavigation = false
      ipcMain.on('set-zoom', (e, host) => {
        const zoomLevel = hostZoomMap[host]
        if (!finalNavigation) w.webContents.zoomLevel = zoomLevel
        console.log()
        e.sender.send(`${host}-zoom-set`)
      })
      ipcMain.on('host1-zoom-level', (e, zoomLevel) => {
        const expectedZoomLevel = hostZoomMap.host1
        expect(zoomLevel).to.equal(expectedZoomLevel)
        if (finalNavigation) {
          done()
        } else {
          w.loadURL(`${zoomScheme}://host2`)
        }
      })
      ipcMain.once('host2-zoom-level', (e, zoomLevel) => {
        const expectedZoomLevel = hostZoomMap.host2
        expect(zoomLevel).to.equal(expectedZoomLevel)
        finalNavigation = true
        w.webContents.goBack()
      })
      w.loadURL(`${zoomScheme}://host1`)
    })

    it('can propagate zoom level across same session', (done) => {
      const w2 = new BrowserWindow({
        show: false
      })
      w2.webContents.on('did-finish-load', () => {
        const zoomLevel1 = w.webContents.zoomLevel
        expect(zoomLevel1).to.equal(hostZoomMap.host3)

        const zoomLevel2 = w2.webContents.zoomLevel
        expect(zoomLevel1).to.equal(zoomLevel2)
        w2.setClosable(true)
        w2.close()
        done()
      })
      w.webContents.on('did-finish-load', () => {
        w.webContents.zoomLevel = hostZoomMap.host3
        w2.loadURL(`${zoomScheme}://host3`)
      })
      w.loadURL(`${zoomScheme}://host3`)
    })

    it('cannot propagate zoom level across different session', (done) => {
      const w2 = new BrowserWindow({
        show: false,
        webPreferences: {
          partition: 'temp'
        }
      })
      const protocol = w2.webContents.session.protocol
      protocol.registerStringProtocol(zoomScheme, (request, callback) => {
        callback('hello')
      }, (error) => {
        if (error) return done(error)
        w2.webContents.on('did-finish-load', () => {
          const zoomLevel1 = w.webContents.zoomLevel
          expect(zoomLevel1).to.equal(hostZoomMap.host3)

          const zoomLevel2 = w2.webContents.zoomLevel
          expect(zoomLevel2).to.equal(0)
          expect(zoomLevel1).to.not.equal(zoomLevel2)

          protocol.unregisterProtocol(zoomScheme, (error) => {
            if (error) return done(error)
            w2.setClosable(true)
            w2.close()
            done()
          })
        })
        w.webContents.on('did-finish-load', () => {
          w.webContents.zoomLevel = hostZoomMap.host3
          w2.loadURL(`${zoomScheme}://host3`)
        })
        w.loadURL(`${zoomScheme}://host3`)
      })
    })

    it('can persist when it contains iframe', (done) => {
      const server = http.createServer((req, res) => {
        setTimeout(() => {
          res.end()
        }, 200)
      })
      server.listen(0, '127.0.0.1', () => {
        const url = 'http://127.0.0.1:' + server.address().port
        const content = `<iframe src=${url}></iframe>`
        w.webContents.on('did-frame-finish-load', (e, isMainFrame) => {
          if (!isMainFrame) {
            const zoomLevel = w.webContents.zoomLevel
            expect(zoomLevel).to.equal(2.0)

            w.webContents.zoomLevel = 0
            server.close()
            done()
          }
        })
        w.webContents.on('dom-ready', () => {
          w.webContents.zoomLevel = 2.0
        })
        w.loadURL(`data:text/html,${content}`)
      })
    })

    it('cannot propagate when used with webframe', (done) => {
      let finalZoomLevel = 0
      const w2 = new BrowserWindow({
        show: false
      })
      w2.webContents.on('did-finish-load', () => {
        const zoomLevel1 = w.webContents.zoomLevel
        expect(zoomLevel1).to.equal(finalZoomLevel)

        const zoomLevel2 = w2.webContents.zoomLevel
        expect(zoomLevel2).to.equal(0)
        expect(zoomLevel1).to.not.equal(zoomLevel2)

        w2.setClosable(true)
        w2.close()
        done()
      })
      ipcMain.once('temporary-zoom-set', (e, zoomLevel) => {
        w2.loadFile(path.join(fixtures, 'pages', 'c.html'))
        finalZoomLevel = zoomLevel
      })
      w.loadFile(path.join(fixtures, 'pages', 'webframe-zoom.html'))
    })

    it('cannot persist zoom level after navigation with webFrame', (done) => {
      let initialNavigation = true
      const source = `
        const {ipcRenderer, webFrame} = require('electron')
        webFrame.setZoomLevel(0.6)
        ipcRenderer.send('zoom-level-set', webFrame.getZoomLevel())
      `
      w.webContents.on('did-finish-load', () => {
        if (initialNavigation) {
          w.webContents.executeJavaScript(source)
        } else {
          const zoomLevel = w.webContents.zoomLevel
          expect(zoomLevel).to.equal(0)
          done()
        }
      })
      ipcMain.once('zoom-level-set', (e, zoomLevel) => {
        expect(zoomLevel).to.equal(0.6)
        w.loadFile(path.join(fixtures, 'pages', 'd.html'))
        initialNavigation = false
      })
      w.loadFile(path.join(fixtures, 'pages', 'c.html'))
    })
  })

  describe('webrtc ip policy api', () => {
    it('can set and get webrtc ip policies', () => {
      const policies = [
        'default',
        'default_public_interface_only',
        'default_public_and_private_interfaces',
        'disable_non_proxied_udp'
      ]
      policies.forEach((policy) => {
        w.webContents.setWebRTCIPHandlingPolicy(policy)
        expect(w.webContents.getWebRTCIPHandlingPolicy()).to.equal(policy)
      })
    })
  })

  describe('render view deleted events', () => {
    let server = null

    before((done) => {
      server = http.createServer((req, res) => {
        const respond = () => {
          if (req.url === '/redirect-cross-site') {
            res.setHeader('Location', `${server.cross_site_url}/redirected`)
            res.statusCode = 302
            res.end()
          } else if (req.url === '/redirected') {
            res.end('<html><script>window.localStorage</script></html>')
          } else {
            res.end()
          }
        }
        setTimeout(respond, 0)
      })
      server.listen(0, '127.0.0.1', () => {
        server.url = `http://127.0.0.1:${server.address().port}`
        server.cross_site_url = `http://localhost:${server.address().port}`
        done()
      })
    })

    after(() => {
      server.close()
      server = null
    })

    it('does not emit current-render-view-deleted when speculative RVHs are deleted', (done) => {
      let currentRenderViewDeletedEmitted = false
      w.webContents.once('destroyed', () => {
        expect(currentRenderViewDeletedEmitted).to.be.false('current-render-view-deleted was emitted')
        done()
      })
      const renderViewDeletedHandler = () => {
        currentRenderViewDeletedEmitted = true
      }
      w.webContents.on('current-render-view-deleted', renderViewDeletedHandler)
      w.webContents.on('did-finish-load', (e) => {
        w.webContents.removeListener('current-render-view-deleted', renderViewDeletedHandler)
        w.close()
      })
      w.loadURL(`${server.url}/redirect-cross-site`)
    })

    it('emits current-render-view-deleted if the current RVHs are deleted', (done) => {
      let currentRenderViewDeletedEmitted = false
      w.webContents.once('destroyed', () => {
        expect(currentRenderViewDeletedEmitted).to.be.true('current-render-view-deleted wasn\'t emitted')
        done()
      })
      w.webContents.on('current-render-view-deleted', () => {
        currentRenderViewDeletedEmitted = true
      })
      w.webContents.on('did-finish-load', (e) => {
        w.close()
      })
      w.loadURL(`${server.url}/redirect-cross-site`)
    })

    it('emits render-view-deleted if any RVHs are deleted', (done) => {
      let rvhDeletedCount = 0
      w.webContents.once('destroyed', () => {
        const expectedRenderViewDeletedEventCount = 3 // 1 speculative upon redirection + 2 upon window close.
        expect(rvhDeletedCount).to.equal(expectedRenderViewDeletedEventCount, 'render-view-deleted wasn\'t emitted the expected nr. of times')
        done()
      })
      w.webContents.on('render-view-deleted', () => {
        rvhDeletedCount++
      })
      w.webContents.on('did-finish-load', (e) => {
        w.close()
      })
      w.loadURL(`${server.url}/redirect-cross-site`)
    })
  })

  describe('setIgnoreMenuShortcuts(ignore)', () => {
    it('does not throw', () => {
      expect(() => {
        w.webContents.setIgnoreMenuShortcuts(true)
        w.webContents.setIgnoreMenuShortcuts(false)
      }).to.not.throw()
    })
  })

  describe('create()', () => {
    it('does not crash on exit', async () => {
      const appPath = path.join(__dirname, 'fixtures', 'api', 'leak-exit-webcontents.js')
      const electronPath = remote.getGlobal('process').execPath
      const appProcess = ChildProcess.spawn(electronPath, [appPath])
      const [code] = await emittedOnce(appProcess, 'close')
      expect(code).to.equal(0)
    })
  })

  // Destroying webContents in its event listener is going to crash when
  // Electron is built in Debug mode.
  xdescribe('destroy()', () => {
    let server

    before((done) => {
      server = http.createServer((request, response) => {
        switch (request.url) {
          case '/404':
            response.statusCode = '404'
            response.end()
            break
          case '/301':
            response.statusCode = '301'
            response.setHeader('Location', '/200')
            response.end()
            break
          case '/200':
            response.statusCode = '200'
            response.end('hello')
            break
          default:
            done('unsupported endpoint')
        }
      }).listen(0, '127.0.0.1', () => {
        server.url = 'http://127.0.0.1:' + server.address().port
        done()
      })
    })

    after(() => {
      server.close()
      server = null
    })

    it('should not crash when invoked synchronously inside navigation observer', (done) => {
      const events = [
        { name: 'did-start-loading', url: `${server.url}/200` },
        { name: 'dom-ready', url: `${server.url}/200` },
        { name: 'did-stop-loading', url: `${server.url}/200` },
        { name: 'did-finish-load', url: `${server.url}/200` },
        // FIXME: Multiple Emit calls inside an observer assume that object
        // will be alive till end of the observer. Synchronous `destroy` api
        // violates this contract and crashes.
        // { name: 'did-frame-finish-load', url: `${server.url}/200` },
        { name: 'did-fail-load', url: `${server.url}/404` }
      ]
      const responseEvent = 'webcontents-destroyed'

      function * genNavigationEvent () {
        let eventOptions = null
        while ((eventOptions = events.shift()) && events.length) {
          eventOptions.responseEvent = responseEvent
          ipcRenderer.send('test-webcontents-navigation-observer', eventOptions)
          yield 1
        }
      }

      const gen = genNavigationEvent()
      ipcRenderer.on(responseEvent, () => {
        if (!gen.next().value) done()
      })
      gen.next()
    })
  })

  describe('did-change-theme-color event', () => {
    it('is triggered with correct theme color', (done) => {
      let count = 0
      w.webContents.on('did-change-theme-color', (e, color) => {
        if (count === 0) {
          count += 1
          expect(color).to.equal('#FFEEDD')
          w.loadFile(path.join(fixtures, 'pages', 'base-page.html'))
        } else if (count === 1) {
          expect(color).to.be.null()
          done()
        }
      })
      w.loadFile(path.join(fixtures, 'pages', 'theme-color.html'))
    })
  })

  describe('console-message event', () => {
    it('is triggered with correct log message', (done) => {
      w.webContents.on('console-message', (e, level, message) => {
        // Don't just assert as Chromium might emit other logs that we should ignore.
        if (message === 'a') {
          done()
        }
      })
      w.loadFile(path.join(fixtures, 'pages', 'a.html'))
    })
  })

  describe('ipc-message event', () => {
    it('emits when the renderer process sends an asynchronous message', async () => {
      const webContents = remote.getCurrentWebContents()
      const promise = emittedOnce(webContents, 'ipc-message')

      ipcRenderer.send('message', 'Hello World!')

      const [, channel, message] = await promise
      expect(channel).to.equal('message')
      expect(message).to.equal('Hello World!')
    })
  })

  describe('ipc-message-sync event', () => {
    it('emits when the renderer process sends a synchronous message', async () => {
      const webContents = remote.getCurrentWebContents()
      const promise = emittedOnce(webContents, 'ipc-message-sync')

      ipcRenderer.send('handle-next-ipc-message-sync', 'foobar')
      const result = ipcRenderer.sendSync('message', 'Hello World!')

      const [, channel, message] = await promise
      expect(channel).to.equal('message')
      expect(message).to.equal('Hello World!')
      expect(result).to.equal('foobar')
    })
  })

  describe('referrer', () => {
    it('propagates referrer information to new target=_blank windows', (done) => {
      const server = http.createServer((req, res) => {
        if (req.url === '/should_have_referrer') {
          expect(req.headers.referer).to.equal(`http://127.0.0.1:${server.address().port}/`)
          return done()
        }
        res.end('<a id="a" href="/should_have_referrer" target="_blank">link</a>')
      })
      server.listen(0, '127.0.0.1', () => {
        const url = 'http://127.0.0.1:' + server.address().port + '/'
        w.webContents.once('did-finish-load', () => {
          w.webContents.once('new-window', (event, newUrl, frameName, disposition, options, features, referrer) => {
            expect(referrer.url).to.equal(url)
            expect(referrer.policy).to.equal('no-referrer-when-downgrade')
          })
          w.webContents.executeJavaScript('a.click()')
        })
        w.loadURL(url)
      })
    })

    // TODO(jeremy): window.open() in a real browser passes the referrer, but
    // our hacked-up window.open() shim doesn't. It should.
    xit('propagates referrer information to windows opened with window.open', (done) => {
      const server = http.createServer((req, res) => {
        if (req.url === '/should_have_referrer') {
          expect(req.headers.referer).to.equal(`http://127.0.0.1:${server.address().port}/`)
          return done()
        }
        res.end('')
      })
      server.listen(0, '127.0.0.1', () => {
        const url = 'http://127.0.0.1:' + server.address().port + '/'
        w.webContents.once('did-finish-load', () => {
          w.webContents.once('new-window', (event, newUrl, frameName, disposition, options, features, referrer) => {
            expect(referrer.url).to.equal(url)
            expect(referrer.policy).to.equal('no-referrer-when-downgrade')
          })
          w.webContents.executeJavaScript('window.open(location.href + "should_have_referrer")')
        })
        w.loadURL(url)
      })
    })
  })

  describe('webframe messages in sandboxed contents', () => {
    it('responds to executeJavaScript', async () => {
      w.destroy()
      w = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true
        }
      })
      await w.loadURL('about:blank')
      const result = await w.webContents.executeJavaScript('37 + 5')
      expect(result).to.equal(42)
    })
  })

  describe('preload-error event', () => {
    const generateSpecs = (description, sandbox) => {
      describe(description, () => {
        it('is triggered when unhandled exception is thrown', async () => {
          const preload = path.join(fixtures, 'module', 'preload-error-exception.js')

          w.destroy()
          w = new BrowserWindow({
            show: false,
            webPreferences: {
              sandbox,
              preload
            }
          })

          const promise = emittedOnce(w.webContents, 'preload-error')
          w.loadURL('about:blank')

          const [, preloadPath, error] = await promise
          expect(preloadPath).to.equal(preload)
          expect(error.message).to.equal('Hello World!')
        })

        it('is triggered on syntax errors', async () => {
          const preload = path.join(fixtures, 'module', 'preload-error-syntax.js')

          w.destroy()
          w = new BrowserWindow({
            show: false,
            webPreferences: {
              sandbox,
              preload
            }
          })

          const promise = emittedOnce(w.webContents, 'preload-error')
          w.loadURL('about:blank')

          const [, preloadPath, error] = await promise
          expect(preloadPath).to.equal(preload)
          expect(error.message).to.equal('foobar is not defined')
        })

        it('is triggered when preload script loading fails', async () => {
          const preload = path.join(fixtures, 'module', 'preload-invalid.js')

          w.destroy()
          w = new BrowserWindow({
            show: false,
            webPreferences: {
              sandbox,
              preload
            }
          })

          const promise = emittedOnce(w.webContents, 'preload-error')
          w.loadURL('about:blank')

          const [, preloadPath, error] = await promise
          expect(preloadPath).to.equal(preload)
          expect(error.message).to.contain('preload-invalid.js')
        })
      })
    }

    generateSpecs('without sandbox', false)
    generateSpecs('with sandbox', true)
  })

  describe('takeHeapSnapshot()', () => {
    it('works with sandboxed renderers', async () => {
      w.destroy()
      w = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true
        }
      })

      await w.loadURL('about:blank')

      const filePath = path.join(remote.app.getPath('temp'), 'test.heapsnapshot')

      const cleanup = () => {
        try {
          fs.unlinkSync(filePath)
        } catch (e) {
          // ignore error
        }
      }

      try {
        await w.webContents.takeHeapSnapshot(filePath)
        const stats = fs.statSync(filePath)
        expect(stats.size).not.to.be.equal(0)
      } finally {
        cleanup()
      }
    })

    it('fails with invalid file path', async () => {
      w.destroy()
      w = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true
        }
      })

      await w.loadURL('about:blank')

      const promise = w.webContents.takeHeapSnapshot('')
      return expect(promise).to.be.eventually.rejectedWith(Error, 'takeHeapSnapshot failed')
    })
  })

  describe('setBackgroundThrottling()', () => {
    it('does not crash when allowing', (done) => {
      w.webContents.setBackgroundThrottling(true)
      done()
    })

    it('does not crash when disallowing', (done) => {
      w.destroy()
      w = new BrowserWindow({
        show: false,
        width: 400,
        height: 400,
        webPreferences: {
          backgroundThrottling: true
        }
      })

      w.webContents.setBackgroundThrottling(false)
      done()
    })

    it('does not crash when called via BrowserWindow', (done) => {
      w.setBackgroundThrottling(true)
      done()
    })
  })

  describe('getPrinterList()', () => {
    before(function () {
      if (!features.isPrintingEnabled()) {
        return closeWindow(w).then(() => {
          w = null
          this.skip()
        })
      }
    })

    it('can get printer list', async () => {
      w.destroy()
      w = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true
        }
      })
      await w.loadURL('data:text/html,%3Ch1%3EHello%2C%20World!%3C%2Fh1%3E')
      const printers = w.webContents.getPrinters()
      expect(printers).to.be.an('array')
    })
  })

  describe('printToPDF()', () => {
    before(function () {
      if (!features.isPrintingEnabled()) {
        return closeWindow(w).then(() => {
          w = null
          this.skip()
        })
      }
    })

    it('can print to PDF', async () => {
      w.destroy()
      w = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true
        }
      })
      await w.loadURL('data:text/html,%3Ch1%3EHello%2C%20World!%3C%2Fh1%3E')
      const data = await w.webContents.printToPDF({})
      expect(data).to.be.an.instanceof(Buffer).that.is.not.empty()
    })
  })

  // FIXME: disable during chromium update due to crash in content::WorkerScriptFetchInitation::CreateScriptLoaderOnIO
  xdescribe('Shared Workers', () => {
    let worker1
    let worker2
    let vectorOfWorkers

    before(() => {
      worker1 = new SharedWorker('../fixtures/api/shared-worker/shared-worker1.js')
      worker2 = new SharedWorker('../fixtures/api/shared-worker/shared-worker2.js')
      worker1.port.start()
      worker2.port.start()
    })

    after(() => {
      worker1.port.close()
      worker2.port.close()
    })

    it('can get multiple shared workers', () => {
      const contents = webContents.getAllWebContents()
      vectorOfWorkers = contents[0].getAllSharedWorkers()

      expect(vectorOfWorkers.length).to.equal(2)
      expect(vectorOfWorkers[0].url).to.contain('shared-worker')
      expect(vectorOfWorkers[1].url).to.contain('shared-worker')
    })

    it('can inspect a specific shared worker', (done) => {
      const contents = webContents.getAllWebContents()
      contents[0].once('devtools-opened', () => {
        contents[0].closeDevTools()
      })
      contents[0].once('devtools-closed', () => {
        done()
      })
      contents[0].inspectSharedWorkerById(vectorOfWorkers[0].id)
    })
  })
})
