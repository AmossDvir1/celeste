package io.github.amossdvir1.celeste;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Files pasted into the message box, as in a messaging app: from the keyboard's clipboard (any item it offers, not only the
 * latest) or from the Paste in the text's menu. The web view's own paste does not give pictures or files to the page, so the
 * app's WebView (CelesteWebView) hands them here, and the page gets them as a "pasted" event.
 */
final class Pasted {
    /** The types a message can carry as files. Plain text and links paste as text, as always. */
    static final String[] TYPES = {"image/*", "video/*", "audio/*", "application/*"};
    private static final long MAX_TOTAL = 25L * 1048576;
    private static final int MAX_FILES = 10;
    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();

    private Pasted() {}

    /** Whether the clipboard holds a file now (only its description is looked at). */
    static boolean clipboardHasFiles(Context ctx) {
        try {
            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            ClipDescription d = cm == null ? null : cm.getPrimaryClipDescription();
            if (d == null) return false;
            for (String t : TYPES) if (d.hasMimeType(t)) return true;
        } catch (Exception ignored) {
            // Nothing to paste.
        }
        return false;
    }

    /** The paste in the text's menu: what is on the clipboard goes to the page. */
    static void fromClipboard(Context ctx) {
        try {
            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm == null ? null : cm.getPrimaryClip();
            if (clip != null) fromClip(ctx, clip);
        } catch (Exception e) {
            send(null, "Could not read the clipboard.");
        }
    }

    /** What the keyboard (or the menu) put into the box: read and sent on, off the main thread. */
    static void fromClip(Context ctx, ClipData clip) {
        List<Uri> uris = new ArrayList<>();
        for (int i = 0; i < clip.getItemCount() && uris.size() < MAX_FILES; i++) {
            Uri u = clip.getItemAt(i).getUri();
            if (u != null) uris.add(u);
        }
        if (uris.isEmpty()) return;
        POOL.execute(() -> {
            try {
                JSArray out = new JSArray();
                long total = 0;
                int n = 0;
                for (Uri uri : uris) {
                    String type = ctx.getContentResolver().getType(uri);
                    if (type == null) type = "application/octet-stream";
                    String name = null;
                    try (Cursor c = ctx.getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                        if (c != null && c.moveToFirst()) name = c.getString(0);
                    } catch (Exception ignored) {
                        // No name: one is made up.
                    }
                    n++;
                    if (name == null || name.isEmpty()) name = "pasted-" + n + (type.startsWith("image/") ? "." + type.substring(6).replaceAll("[^a-z0-9]", "") : "");
                    ByteArrayOutputStream b = new ByteArrayOutputStream();
                    try (InputStream in = ctx.getContentResolver().openInputStream(uri)) {
                        if (in == null) continue;
                        byte[] buf = new byte[16384];
                        for (int r; (r = in.read(buf)) > 0; ) {
                            total += r;
                            if (total > MAX_TOTAL) {
                                send(null, "That is more than 25 MB.");
                                return;
                            }
                            b.write(buf, 0, r);
                        }
                    }
                    JSObject f = new JSObject();
                    f.put("name", name);
                    f.put("mime", type);
                    f.put("data", Base64.encodeToString(b.toByteArray(), Base64.NO_WRAP));
                    out.put(f);
                }
                send(out, null);
            } catch (Exception e) {
                send(null, "Could not paste that.");
            }
        });
    }

    private static void send(JSArray files, String error) {
        CelesteNativePlugin p = CelesteNativePlugin.live;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("files", files == null ? new JSArray() : files);
        if (error != null) o.put("error", error);
        p.pasted(o);
    }
}
