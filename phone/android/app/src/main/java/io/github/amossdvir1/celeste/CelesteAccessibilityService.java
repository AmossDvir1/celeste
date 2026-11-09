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
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;

/**
 * The phone-control service (step A3). Android lets an app see the screen and tap only through an accessibility service,
 * which the person switches on in Android's settings. It acts only while PhoneControl has a grant; then it draws a
 * coloured border and a Stop button over everything, and three presses of volume down stop it too.
 */
public class CelesteAccessibilityService extends AccessibilityService {
    static volatile CelesteAccessibilityService live;

    private final Handler main = new Handler(Looper.getMainLooper());
    private View border;
    private TextView stop;
    private final Rect stopBounds = new Rect();
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

            stop = new TextView(this);
            stop.setText("■  Stop Celeste");
            stop.setTextColor(Color.WHITE);
            stop.setTextSize(15);
            int pad = (int) (14 * getResources().getDisplayMetrics().density);
            stop.setPadding(pad * 2, pad, pad * 2, pad);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(0xF0111111);
            bg.setCornerRadius(100);
            bg.setStroke(3, 0xFFF5487F);
            stop.setBackground(bg);
            stop.setOnClickListener(v -> PhoneControl.end(this, "The user pressed Stop on the phone."));
            WindowManager.LayoutParams top = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    PixelFormat.TRANSLUCENT);
            top.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
            top.y = (int) (40 * getResources().getDisplayMetrics().density);
            wm.addView(stop, top);
            stop.post(() -> stop.getGlobalVisibleRect(stopBounds));
        });
    }

    void hideOverlay() {
        main.post(() -> {
            WindowManager wm = getSystemService(WindowManager.class);
            if (border != null) try { wm.removeView(border); } catch (Exception ignored) {}
            if (stop != null) try { wm.removeView(stop); } catch (Exception ignored) {}
            border = null;
            stop = null;
            stopBounds.setEmpty();
        });
    }

    /** True when (x, y) is on Celeste's own Stop button, which the assistant may never press. */
    boolean onStop(int x, int y) {
        Rect r = new Rect(stopBounds);
        r.inset(-24, -24);
        return !stopBounds.isEmpty() && r.contains(x, y);
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

    /** A picture of the screen, scaled to 720 pixels wide, as base64 JPEG. Calls back with null when it cannot. */
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
                    int w = 720, h = Math.round(sw.getHeight() * (720f / sw.getWidth()));
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
        dispatchGesture(g, new GestureResultCallback() {
            @Override public void onCompleted(GestureDescription d) { main.postDelayed(done, 600); }
            @Override public void onCancelled(GestureDescription d) { main.postDelayed(done, 300); }
        }, main);
    }
}
