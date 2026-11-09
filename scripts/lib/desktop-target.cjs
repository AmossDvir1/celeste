// A window of our own for the desktop control check to click and type into (scripts/desktop-check.mjs). It reports nothing by itself: the
// check reads what arrived from its page. It is never part of Celeste.
const { app, BrowserWindow } = require('electron')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    x: Number(process.env.TARGET_X ?? 1000),
    y: Number(process.env.TARGET_Y ?? 300),
    width: 560,
    height: 420,
    title: 'Desktop control target',
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true }
  })
  void win.loadURL(
    'data:text/html,' +
      encodeURIComponent(`<body style="font:22px sans-serif;margin:30px">
        <p>Target window</p>
        <input id="box" aria-label="Field" style="font-size:24px;width:440px"><br><br>
        <button id="btn" style="font-size:26px;padding:12px 24px">Press me</button>
        <script>window.clicks = 0; document.getElementById('btn').onclick = () => { window.clicks++ }</script>
      </body>`)
  )
})
app.on('window-all-closed', () => app.quit())
