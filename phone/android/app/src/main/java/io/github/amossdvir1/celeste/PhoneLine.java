package io.github.amossdvir1.celeste;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The background service's side of the phone protocol (src/shared/phone.ts in the main project): AES-GCM with the
 * key the app derived when it paired, the same labels, the same request shape. Kept in the app's private storage.
 */
final class PhoneLine {
    static final String LABEL_REQUEST = "celeste-rpc-request";
    static final String LABEL_RESPONSE = "celeste-rpc-response";
    static final String LABEL_PUSH = "celeste-push";
    static final String LABEL_LISTEN = "celeste-listen";
    private static final String PREFS = "celeste-line";
    private static final SecureRandom RANDOM = new SecureRandom();

    final String base;
    final String phoneId;
    final String computer;
    private final SecretKeySpec key;

    PhoneLine(String base, String phoneId, String computer, byte[] key) {
        this.base = base;
        this.phoneId = phoneId;
        this.computer = computer;
        this.key = new SecretKeySpec(key, "AES");
    }

    static void save(Context ctx, String base, String phoneId, String computer, String keyB64) {
        String key;
        try {
            key = SecureStore.seal(keyB64);
        } catch (Exception e) {
            // No Keystore on this phone (rare): the key stays in the app's private storage, as before.
            key = keyB64;
        }
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("base", base).putString("phone", phoneId).putString("computer", computer).putString("key", key).apply();
    }

    static void clear(Context ctx) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    static PhoneLine load(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String base = p.getString("base", null), phone = p.getString("phone", null), key = SecureStore.open(p.getString("key", null));
        if (base == null || phone == null || key == null) return null;
        return new PhoneLine(base, phone, p.getString("computer", "your computer"), Base64.decode(key, Base64.DEFAULT));
    }

    String seal(String json, String label) throws Exception {
        byte[] iv = new byte[12];
        RANDOM.nextBytes(iv);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
        c.updateAAD(label.getBytes(StandardCharsets.UTF_8));
        byte[] ct = c.doFinal(json.getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[12 + ct.length];
        System.arraycopy(iv, 0, out, 0, 12);
        System.arraycopy(ct, 0, out, 12, ct.length);
        return Base64.encodeToString(out, Base64.NO_WRAP);
    }

    String open(String box, String label) throws Exception {
        byte[] all = Base64.decode(box, Base64.DEFAULT);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, all, 0, 12));
        c.updateAAD(label.getBytes(StandardCharsets.UTF_8));
        return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
    }

    static String nonce() {
        byte[] n = new byte[12];
        RANDOM.nextBytes(n);
        return Base64.encodeToString(n, Base64.NO_WRAP);
    }

    /** The stream of pushes, opened with a sealed proof that this phone holds the key. */
    HttpURLConnection openEvents() throws Exception {
        JSONObject proof = new JSONObject().put("ts", System.currentTimeMillis()).put("n", nonce());
        String auth = URLEncoder.encode(seal(proof.toString(), LABEL_LISTEN), "UTF-8");
        HttpURLConnection h = (HttpURLConnection) new URL(base + "/events?phone=" + URLEncoder.encode(phoneId, "UTF-8") + "&auth=" + auth).openConnection();
        h.setConnectTimeout(8000);
        h.setReadTimeout(65000); // The computer sends a ping every 20 seconds.
        return h;
    }

    /** One sealed request, as the app makes them. Throws when the computer refuses or cannot be reached. */
    JSONObject call(String method, JSONArray params) throws Exception {
        JSONObject req = new JSONObject().put("id", 1).put("method", method).put("params", params).put("ts", System.currentTimeMillis()).put("n", nonce());
        JSONObject body = new JSONObject().put("phone", phoneId).put("box", seal(req.toString(), LABEL_REQUEST));
        HttpURLConnection h = (HttpURLConnection) new URL(base + "/rpc").openConnection();
        h.setConnectTimeout(8000);
        h.setReadTimeout(20000);
        h.setDoOutput(true);
        h.setRequestMethod("POST");
        h.setRequestProperty("content-type", "text/plain");
        try (OutputStream o = h.getOutputStream()) {
            o.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int status = h.getResponseCode();
        if (status != 200) throw new Exception("The computer answered " + status);
        String text;
        try (InputStream in = h.getInputStream()) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            for (int r; (r = in.read(buf)) > 0; ) b.write(buf, 0, r);
            text = b.toString("UTF-8");
        }
        JSONObject reply = new JSONObject(open(new JSONObject(text).getString("box"), LABEL_RESPONSE));
        if (!reply.optBoolean("ok")) throw new Exception(reply.optString("error", "Refused"));
        return reply;
    }
}
