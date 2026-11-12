package io.github.amossdvir1.celeste;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.Display;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;

/**
 * The phone-control service (step A3). Android lets an app see the screen and tap only through an accessibility service,
 * which the person switches on in Android's settings. It acts only while PhoneControl has a grant; then it draws a
 * coloured border and a Stop button over everything, and three presses of volume down stop it too. A touch from the
 * person pauses it until they press Continue.
 */
public class CelesteAccessibilityService extends AccessibilityService {
    static volatile CelesteAccessibilityService live;

    private final Handler main = new Handler(Looper.getMainLooper());
    private View border;
    /** The pill at the top: Stop, and Continue while paused. It also hears every touch outside it (pausing control). */
    private LinearLayout pill;
    private TextView stop, resume;
    /** Where the pill is on the screen (screen pixels), kept so a tap aimed at it can be told apart. Replaced, never changed. */
    private volatile Rect pillRect = new Rect();
    private boolean pillAtTop = true;
    /** Touches before this time are Celeste's own gestures, not the person's. */
    private volatile long ownUntil;
    private final long[] volumeDowns = new long[3];
    private int volumeIndex;

    /** What phone_screen listed last: the assistant taps by these numbers. */
    static final class Element {
        int id;
        String role, text;
        Rect bounds;
        boolean clickable, editable, password, scrollable;
        AccessibilityNodeInfo node;
    }
    private final List<Element> lastScreen = new ArrayList<>();

    @Override
    protected void onServiceConnected() {
        live = this;
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        live = null;
        hideOverlay();
        PhoneControl.end(this, "Phone control was switched off in Android's settings.");
        return super.onUnbind(intent);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Nothing to do between actions: the screen is read only when the assistant asks.
    }

    @Override
    public void onInterrupt() {}

    /** Volume down three times within a second and a half stops control, wherever the person is. */
    @Override
    protected boolean onKeyEvent(KeyEvent e) {
        if (!PhoneControl.active() || e.getKeyCode() != KeyEvent.KEYCODE_VOLUME_DOWN || e.getAction() != KeyEvent.ACTION_DOWN) return false;
        long now = System.currentTimeMillis();
        volumeDowns[volumeIndex++ % 3] = now;
        long oldest = Math.min(volumeDowns[0], Math.min(volumeDowns[1], volumeDowns[2]));
        if (volumeIndex >= 3 && now - oldest < 1500) PhoneControl.end(this, "The user stopped it with the volume key.");
        return false;
    }

    static boolean enabled(Context ctx) {
        String on = android.provider.Settings.Secure.getString(ctx.getContentResolver(), "enabled_accessibility_services");
        return on != null && on.contains(ctx.getPackageName() + "/");
    }

    // ---- The overlay: a border round the screen and a Stop button, while control lasts ----

    void showOverlay() {
        main.post(() -> {
            if (border != null) return;
            WindowManager wm = getSystemService(WindowManager.class);
            border = new View(this) {
                private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
                @Override
                protected void onDraw(Canvas c) {
                    float w = getWidth(), h = getHeight(), s = 6 * getResources().getDisplayMetrics().density;
                    p.setStyle(Paint.Style.STROKE);
                    p.setStrokeWidth(s);
                    p.setShader(new LinearGradient(0, 0, w, h, new int[]{0xFF4D6DF0, 0xFFA04BD8, 0xFFF5487F}, null, Shader.TileMode.CLAMP));
                    float r = 28 * getResources().getDisplayMetrics().density;
                    c.drawRoundRect(new RectF(s / 2, s / 2, w - s / 2, h - s / 2), r, r, p);
                }
            };
            WindowManager.LayoutParams full = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    PixelFormat.TRANSLUCENT);
            wm.addView(border, full);

            float dp = getResources().getDisplayMetrics().density;
            int pad = (int) (14 * dp);
            pill = new LinearLayout(this);
            pill.setOrientation(LinearLayout.HORIZONTAL);
            pill.setGravity(Gravity.CENTER_VERTICAL);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(0xF0111111);
            bg.setCornerRadius(100);
            bg.setStroke(3, 0xFFF5487F);
            pill.setBackground(bg);

            resume = new TextView(this);
            resume.setText("▶  Continue");
            resume.setTextColor(0xFF7CF0B0);
            resume.setTextSize(15);
            resume.setPadding(pad * 2, pad, pad, pad);
            resume.setVisibility(View.GONE);
            resume.setOnClickListener(v -> PhoneControl.resume(this));
            pill.addView(resume);

            stop = new TextView(this);
            stop.setText("■  Stop Celeste");
            stop.setTextColor(Color.WHITE);
            stop.setTextSize(15);
            stop.setPadding(pad * 2, pad, pad * 2, pad);
            stop.setOnClickListener(v -> PhoneControl.end(this, "The user pressed Stop on the phone."));
            pill.addView(stop);

            // The person's own touch wins: Android tells this window about every touch outside it (where, it does not say
            // for other apps' windows). Celeste's own gestures are told apart by time.
            pill.setOnTouchListener((v, ev) -> {
                if (ev.getActionMasked() == MotionEvent.ACTION_OUTSIDE) personTouched();
                return false;
            });
            WindowManager.LayoutParams top = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                    PixelFormat.TRANSLUCENT);
            pillAtTop = true;
            top.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
            top.y = (int) (40 * dp);
            wm.addView(pill, top);
            measurePill();
        });
    }

    /** Works out where the pill is on the screen. (Not getGlobalVisibleRect: for a window of its own that is relative to the window.) */
    private void measurePill() {
        if (pill == null) return;
        pill.post(() -> {
            if (pill == null) return;
            int[] xy = new int[2];
            pill.getLocationOnScreen(xy);
            pillRect = new Rect(xy[0], xy[1], xy[0] + pill.getWidth(), xy[1] + pill.getHeight());
        });
    }

    private void placePill() {
        if (pill == null) return;
        WindowManager.LayoutParams lp = (WindowManager.LayoutParams) pill.getLayoutParams();
        float dp = getResources().getDisplayMetrics().density;
        lp.gravity = (pillAtTop ? Gravity.TOP : Gravity.BOTTOM) | Gravity.CENTER_HORIZONTAL;
        lp.y = (int) ((pillAtTop ? 40 : 72) * dp);
        try { getSystemService(WindowManager.class).updateViewLayout(pill, lp); } catch (Exception ignored) {}
        measurePill();
    }

    /**
     * The assistant is about to tap (x, y). If that is where Celeste's own Stop pill is (a tab or button at the top of an app
     * often is), the pill moves to the other end of the screen first, so the tap reaches the app and never the Stop.
     */
    void clearPillFor(int x, int y, Runnable then) {
        main.post(() -> {
            Rect r = new Rect(pillRect);
            r.inset(-24, -24);
            if (pill == null || r.isEmpty() || !r.contains(x, y)) {
                then.run();
                return;
            }
            pillAtTop = !pillAtTop;
            placePill();
            // Go ahead once the window has moved and been measured again.
            main.postDelayed(then, 450);
        });
    }

    private void personTouched() {
        if (!PhoneControl.active() || PhoneControl.paused()) return;
        if (System.currentTimeMillis() < ownUntil || PhoneControl.asking()) return;
        // In Celeste itself the person is watching or answering, not taking the phone back.
        if (getPackageName().equals(foregroundPackage())) return;
        PhoneControl.pause(this);
    }

    /** While paused the border fades and Continue shows beside Stop. */
    void showPaused(boolean on) {
        main.post(() -> {
            if (border != null) border.setAlpha(on ? 0.35f : 1f);
            if (resume != null) resume.setVisibility(on ? View.VISIBLE : View.GONE);
            if (stop != null) {
                stop.setText(on ? "■  Stop" : "■  Stop Celeste");
                int pad = (int) (14 * getResources().getDisplayMetrics().density);
                stop.setPadding(on ? pad : pad * 2, pad, pad * 2, pad);
            }
            measurePill();
        });
    }

    void hideOverlay() {
        main.post(() -> {
            WindowManager wm = getSystemService(WindowManager.class);
            if (border != null) try { wm.removeView(border); } catch (Exception ignored) {}
            if (pill != null) try { wm.removeView(pill); } catch (Exception ignored) {}
            border = null;
            pill = null;
            stop = null;
            resume = null;
            pillRect = new Rect();
            pillAtTop = true;
        });
    }

    /** True when (x, y) is on Celeste's own Stop button, which the assistant may never press. */
    boolean onStop(int x, int y) {
        Rect r = new Rect(pillRect);
        r.inset(-24, -24);
        return !pillRect.isEmpty() && r.contains(x, y);
    }

    // ---- Reading the screen ----

    String foregroundPackage() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        return root != null && root.getPackageName() != null ? root.getPackageName().toString() : "";
    }

    /** The elements on screen, numbered; kept for taps and typing by number. */
    List<Element> readScreen() {
        lastScreen.clear();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null) walk(root, 0);
        return lastScreen;
    }

    private void walk(AccessibilityNodeInfo n, int depth) {
        if (n == null || depth > 40 || lastScreen.size() >= 150 || !n.isVisibleToUser()) return;
        CharSequence t = n.getText(), d = n.getContentDescription();
        boolean interesting = n.isClickable() || n.isEditable() || n.isCheckable() || n.isScrollable() || (t != null && t.length() > 0) || (d != null && d.length() > 0);
        if (interesting) {
            Element e = new Element();
            e.id = lastScreen.size() + 1;
            String cls = n.getClassName() != null ? n.getClassName().toString() : "View";
            e.role = cls.substring(cls.lastIndexOf('.') + 1);
            e.password = n.isPassword();
            String text = t != null ? t.toString() : "";
            String desc = d != null ? d.toString() : "";
            e.text = e.password ? "(password field)" : (text.isEmpty() ? desc : (desc.isEmpty() || desc.equals(text) ? text : text + " — " + desc));
            if (e.text.length() > 120) e.text = e.text.substring(0, 119) + "…";
            if (n.isCheckable()) e.text += n.isChecked() ? " [on]" : " [off]";
            e.bounds = new Rect();
            n.getBoundsInScreen(e.bounds);
            e.clickable = n.isClickable();
            e.editable = n.isEditable();
            e.scrollable = n.isScrollable();
            e.node = n;
            lastScreen.add(e);
        }
        for (int i = 0; i < n.getChildCount(); i++) walk(n.getChild(i), depth + 1);
    }

    Element element(int id) {
        for (Element e : lastScreen) if (e.id == id) return e;
        return null;
    }

    /** What the person would read as the label of the button at (x, y), read fresh from the screen: "" when there is none. */
    String labelAt(int x, int y) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return "";
        AccessibilityNodeInfo hit = null, deepest = null, n = root;
        Rect r = new Rect();
        // Down through the children under the point; the deepest tappable one is what a tap there presses.
        for (int depth = 0; n != null && depth < 40; depth++) {
            if (n.isClickable() || n.isLongClickable()) hit = n;
            if (depth > 0) deepest = n;
            AccessibilityNodeInfo next = null;
            for (int i = n.getChildCount() - 1; i >= 0 && next == null; i--) {
                AccessibilityNodeInfo c = n.getChild(i);
                if (c == null || !c.isVisibleToUser()) continue;
                c.getBoundsInScreen(r);
                if (r.contains(x, y)) next = c;
            }
            n = next;
        }
        if (hit != null && hit != root) return labelOf(hit);
        // Nothing tappable under the point: only the words right there, never the whole screen's (one "send" anywhere on
        // it would ask again for nothing).
        return deepest != null ? ownLabel(deepest) : "";
    }

    /** The node's own text and description, without what is inside it. */
    private static String ownLabel(AccessibilityNodeInfo n) {
        if (n.isPassword()) return "";
        StringBuilder b = new StringBuilder();
        if (n.getText() != null) b.append(n.getText()).append(' ');
        if (n.getContentDescription() != null) b.append(n.getContentDescription());
        return b.toString().trim();
    }

    /** The text and description of a node and what is inside it (a button's words are often in a child). */
    static String labelOf(AccessibilityNodeInfo n) {
        StringBuilder b = new StringBuilder();
        collect(n, b, 0);
        return b.toString().trim();
    }

    private static void collect(AccessibilityNodeInfo n, StringBuilder b, int depth) {
        if (n == null || depth > 6 || b.length() > 200) return;
        if (!n.isPassword()) {
            if (n.getText() != null) b.append(n.getText()).append(' ');
            if (n.getContentDescription() != null) b.append(n.getContentDescription()).append(' ');
        }
        for (int i = 0; i < n.getChildCount(); i++) collect(n.getChild(i), b, depth + 1);
    }

    /** Calls back once the app on screen is no longer `before` (a key's animation has finished), or after `maxMs`. */
    void afterChange(String before, long minMs, long maxMs, Runnable done) {
        long start = System.currentTimeMillis();
        main.postDelayed(new Runnable() {
            @Override public void run() {
                long gone = System.currentTimeMillis() - start;
                if (gone >= maxMs || !before.equals(foregroundPackage())) main.postDelayed(done, 250);
                else main.postDelayed(this, 100);
            }
        }, minMs);
    }

    /** A picture of the screen, shrunk by PhoneControl.pictureScale, as base64 JPEG. Calls back with null when it cannot. */
    void screenshot(java.util.function.Consumer<String> done) {
        if (Build.VERSION.SDK_INT < 30) {
            done.accept(null);
            return;
        }
        Executor ex = main::post;
        takeScreenshot(Display.DEFAULT_DISPLAY, ex, new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult r) {
                try {
                    Bitmap hw = Bitmap.wrapHardwareBuffer(r.getHardwareBuffer(), r.getColorSpace());
                    Bitmap sw = hw.copy(Bitmap.Config.ARGB_8888, false);
                    float k = PhoneControl.pictureScale(sw.getWidth(), sw.getHeight());
                    int w = Math.round(sw.getWidth() * k), h = Math.round(sw.getHeight() * k);
                    Bitmap small = Bitmap.createScaledBitmap(sw, w, h, true);
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    small.compress(Bitmap.CompressFormat.JPEG, 60, out);
                    r.getHardwareBuffer().close();
                    done.accept(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                } catch (Exception e) {
                    done.accept(null);
                }
            }

            @Override
            public void onFailure(int code) {
                done.accept(null);
            }
        });
    }

    // ---- Acting ----

    void tap(int x, int y, boolean longPress, Runnable done) {
        Path p = new Path();
        p.moveTo(x, y);
        GestureDescription g = new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(p, 0, longPress ? 700 : 60)).build();
        gesture(g, done);
    }

    void swipe(String direction, Runnable done) {
        int w = getResources().getDisplayMetrics().widthPixels, h = getResources().getDisplayMetrics().heightPixels;
        int cx = w / 2, cy = h / 2, dx = 0, dy = 0;
        switch (direction) {
            case "up": dy = -h / 3; break;
            case "down": dy = h / 3; break;
            case "left": dx = -w / 3; break;
            default: dx = w / 3;
        }
        Path p = new Path();
        p.moveTo(cx - dx / 2f, cy - dy / 2f);
        p.lineTo(cx + dx / 2f, cy + dy / 2f);
        gesture(new GestureDescription.Builder().addStroke(new GestureDescription.StrokeDescription(p, 0, 350)).build(), done);
    }

    private void gesture(GestureDescription g, Runnable done) {
        // Its own touches must not look like the person's: quiet for the gesture and a moment after.
        ownUntil = System.currentTimeMillis() + g.getStroke(0).getDuration() + 1_500;
        dispatchGesture(g, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription d) { ownUntil = System.currentTimeMillis() + 300; main.postDelayed(done, 600); }
            @Override public void onCancelled(GestureDescription d) { ownUntil = System.currentTimeMillis() + 300; main.postDelayed(done, 300); }
        }, main);
    }
}
