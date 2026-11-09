// A window of our own for the desktop control check to click and type into (scripts/desktop-check.mjs). It reports nothing by itself: the
// check reads what arrived from its page. It is never part of Celeste. Two of them run at once: the target, and a "cover" that sits over
// part of it, so the check can see that a window in front is refused and painted over.
const { app, BrowserWindow } = require('electron')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    x: Number(process.env.TARGET_X ?? 1000),
    y: Number(process.env.TARGET_Y ?? 300),
    width: Number(process.env.TARGET_W ?? 560),
    height: Number(process.env.TARGET_H ?? 420),
    title: process.env.TARGET_TITLE ?? 'Desktop control target',
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true }
  })
  void win.loadURL(
    'data:text/html,' +
      encodeURIComponent(`<body style="font:22px sans-serif;margin:20px">
        <div>${process.env.TARGET_TITLE ?? 'Target window'}</div>
        <div style="margin-top:12px"><input id="box" aria-label="Field" style="font-size:24px;width:440px"></div>
        <div style="margin-top:12px"><input id="pw" type="password" aria-label="Secret" style="font-size:24px;width:440px"></div>
        <div style="margin-top:12px">
          <button id="btn" style="font-size:24px;padding:10px 20px">Press me</button>
          <button id="del" style="font-size:24px;padding:10px 20px">Delete everything</button>
        </div>
        <script>
          window.clicks = 0
          window.deletes = 0
          document.getElementById('btn').onclick = () => { window.clicks++ }
          document.getElementById('del').onclick = () => { window.deletes++ }
        </script>
      </body>`)
  )
})
app.on('window-all-closed', () => app.quit())
