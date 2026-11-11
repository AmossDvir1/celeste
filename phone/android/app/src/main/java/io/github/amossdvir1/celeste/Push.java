package io.github.amossdvir1.celeste;

import android.content.Context;

import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONArray;

/**
 * Tells the computer how to wake this phone when the app is closed: Firebase's token for this install, sent as a sealed
 * request (`phone.push`) over the Wi-Fi or, away from home, through the relay. The computer keeps it with the pairing.
 */
final class Push {
    private static volatile long last;
    private static volatile String lastToken = "";

    private Push() {}

    /** Gets the token and gives it to the computer, at most every ten minutes unless the token changed. */
    static void sync(Context ctx) {
        final Context app = ctx.getApplicationContext();
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(t -> {
                if (t.isSuccessful() && t.getResult() != null) register(app, t.getResult());
            });
        } catch (Exception e) {
            // Firebase is not set up in this build, or Google's services are missing on this phone: no wake-ups, the rest works.
        }
    }

    static void register(Context ctx, String token) {
        long now = System.currentTimeMillis();
        if (token.equals(lastToken) && now - last < 10 * 60_000) return;
        PhoneLine line = PhoneLine.load(ctx);
        if (line == null) return;
        lastToken = token;
        last = now;
        new Thread(() -> {
            try {
                line.call("phone.push", new JSONArray().put(token));
            } catch (Exception e) {
                // The computer is off, or not reachable: it is told again the next time the app connects.
                last = 0;
            }
        }, "celeste-push").start();
    }
}
