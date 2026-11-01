'use strict';

/* Electron main process for the QuizParty Windows host app.
   There is deliberately no local HTTP server, no LAN IP detection, no port
   selection, and no firewall interaction of any kind: the existing static
   app (index.html/css/js) is loaded directly from disk via file://, and all
   networking the app itself performs is outbound HTTPS/WSS to the
   Cloudflare relay (see relay/) and to PeerJS's/qrcode-generator's CDN
   (unrelated static assets) — nothing needs to be reachable, so there is no
   inbound port and nothing for Windows Firewall to prompt about. */

const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'QuizParty',
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(APP_ROOT, 'index.html'));
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // no File/Edit/View menu bar — this isn't a browser
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
