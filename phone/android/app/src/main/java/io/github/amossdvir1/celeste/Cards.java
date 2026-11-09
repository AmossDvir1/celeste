package io.github.amossdvir1.celeste;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The cards that ask the person something (a phone ability, phone control, a second yes). Each is shown in the app when
 * it is on screen, and as a notification with Deny and Approve; whichever the person answers first counts. When neither
 * can be shown (notifications off and the app closed) the caller is told, so the computer hears at once instead of waiting.
 */
final class Cards {
    interface Answer {
        void run(Context ctx, boolean yes);
    }

    private static final class Card {
        String id, title, text;
        Answer answer;
    }

    private static final Map<String, Card> open = new LinkedHashMap<>();

    private Cards() {}

    /** Shows a card. Returns false when the person cannot see it anywhere. */
    static boolean show(Context ctx, String id, String title, String text, PendingIntent deny, PendingIntent allow, Answer answer) {
        Card c = new Card();
        c.id = id;
        c.title = title;
        c.text = text;
        c.answer = answer;
        synchronized (open) {
            open.put(id, c);
        }
        boolean notifications = NotificationManagerCompat.from(ctx).areNotificationsEnabled();
        if (notifications) ConnectionService.show(ctx, id.hashCode(), title, text, deny, allow);
        boolean inApp = MainActivity.visible && CelesteNativePlugin.live != null;
        CelesteNativePlugin.cardsChanged();
        if (!notifications && !inApp) {
            synchronized (open) {
                open.remove(id);
            }
            return false;
        }
        return true;
    }

    /** The person answered, in the app or on the notification. Runs the card's answer once. */
    static void answer(Context ctx, String id, boolean yes) {
        Card c;
        synchronized (open) {
            c = open.remove(id);
        }
        ctx.getSystemService(NotificationManager.class).cancel(id.hashCode());
        CelesteNativePlugin.cardsChanged();
        PhoneControl.quiet(3_000);
        if (c != null && c.answer != null) c.answer.run(ctx, yes);
    }

    /** Answered another way (Allow on a notification that does the work itself): the card just goes. */
    static void forget(Context ctx, String id) {
        synchronized (open) {
            open.remove(id);
        }
        ctx.getSystemService(NotificationManager.class).cancel(id.hashCode());
        CelesteNativePlugin.cardsChanged();
        PhoneControl.quiet(3_000);
    }

    /** Some card is waiting for the person. */
    static boolean waiting() {
        synchronized (open) {
            return !open.isEmpty();
        }
    }

    static JSArray list() {
        List<Card> all;
        synchronized (open) {
            all = new ArrayList<>(open.values());
        }
        JSArray a = new JSArray();
        for (Card c : all) {
            JSObject o = new JSObject();
            o.put("id", c.id);
            o.put("title", c.title);
            o.put("text", c.text);
            a.put(o);
        }
        return a;
    }
}
