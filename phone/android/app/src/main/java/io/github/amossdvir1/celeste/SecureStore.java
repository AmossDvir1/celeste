package io.github.amossdvir1.celeste;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Secrets kept by the app (the pairing's keys, the background line's key), encrypted with a key that lives in the Android
 * Keystore and never leaves it. What is written to the app's storage is only ciphertext: "k1:" + IV + ciphertext, base64.
 * Anything else read back is a value from before this was added, returned as it is (and encrypted when next written).
 */
final class SecureStore {
    private static final String ALIAS = "celeste-store";
    private static final String PREFIX = "k1:";

    private SecureStore() {}

    private static synchronized SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return g.generateKey();
    }

    /** The value, encrypted. Null in, null out. */
    static String seal(String plain) throws Exception {
        if (plain == null) return null;
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = c.getIV();
        byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        byte[] all = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, all, 0, iv.length);
        System.arraycopy(ct, 0, all, iv.length, ct.length);
        return PREFIX + Base64.encodeToString(all, Base64.NO_WRAP);
    }

    /** The value, decrypted; a value written before encryption comes back as it is. Null when it cannot be read. */
    static String open(String stored) {
        if (stored == null || !stored.startsWith(PREFIX)) return stored;
        try {
            byte[] all = Base64.decode(stored.substring(PREFIX.length()), Base64.NO_WRAP);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 0, 12));
            return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
        } catch (Exception e) {
            // The Keystore key is gone (a restored backup, a reset): the secret is lost, and the phone pairs again.
            return null;
        }
    }

    private static final String PREFS = "celeste-secure";

    /** A named secret for the app's screens (the pairing). */
    static String get(Context ctx, String name) {
        return open(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(name, null));
    }

    static void set(Context ctx, String name, String value) throws Exception {
        if (value == null) ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(name).apply();
        else ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(name, seal(value)).apply();
    }
}
