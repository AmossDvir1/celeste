package io.github.amossdvir1.celeste;

import android.app.Notification;
import android.app.RemoteInput;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.ArrayList;
import java.util.List;

/**
 * Lets Celeste read the notifications on the phone and answer message notifications, only when the person allowed it in
 * Android's Notification access, switched it on in the app, and pressed Allow for that one request.
 */
public class CelesteNotificationListener extends NotificationListenerService {
    private static volatile CelesteNotificationListener live;

    static final class Item {
        String key, app, title, text;
        boolean canReply;
        long when;
    }

    @Override
    public void onListenerConnected() {
        live = this;
    }

    @Override
    public void onListenerDisconnected() {
        live = null;
    }

    static boolean allowed(Context ctx) {
        String flat = Settings.Secure.getString(ctx.getContentResolver(), "enabled_notification_listeners");
        return flat != null && flat.contains(new ComponentName(ctx, CelesteNotificationListener.class).flattenToString());
    }

    /** The notifications on the phone now, newest first, without Celeste's own or ongoing ones. Null when access is off. */
    static List<Item> recent() {
        CelesteNotificationListener l = live;
        if (l == null) return null;
        List<Item> out = new ArrayList<>();
        StatusBarNotification[] all;
        try { all = l.getActiveNotifications(); } catch (Exception e) { return null; }
        if (all == null) return out;
        java.util.Arrays.sort(all, (x, y) -> Long.compare(y.getPostTime(), x.getPostTime()));
        for (StatusBarNotification s : all) {
            // Never-list apps (password managers, authenticators, and the person's own picks such as their bank) stay unseen.
            if (s.getPackageName().equals(l.getPackageName()) || s.isOngoing() || PhoneControl.never(l, s.getPackageName())) continue;
            Notification n = s.getNotification();
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) continue;
            Bundle x = n.extras;
            Item it = new Item();
            it.key = s.getKey();
            it.app = appName(l, s.getPackageName());
            it.title = text(x.getCharSequence(Notification.EXTRA_TITLE));
            CharSequence big = x.getCharSequence(Notification.EXTRA_BIG_TEXT);
            it.text = text(big != null ? big : x.getCharSequence(Notification.EXTRA_TEXT));
            it.canReply = replyAction(n) != null;
            it.when = s.getPostTime();
            if (it.title.isEmpty() && it.text.isEmpty()) continue;
            out.add(it);
            if (out.size() >= 30) break;
        }
        return out;
    }

    static Item find(String key) {
        List<Item> all = recent();
        if (all == null) return null;
        for (Item i : all) if (i.key.equals(key)) return i;
        return null;
    }

    /** Sends `reply` through the notification's own reply action, as the person would. */
    static boolean reply(Context ctx, String key, String reply) {
        CelesteNotificationListener l = live;
        if (l == null) return false;
        for (StatusBarNotification s : l.getActiveNotifications()) {
            if (!s.getKey().equals(key)) continue;
            Notification.Action a = replyAction(s.getNotification());
            if (a == null) return false;
            Intent fill = new Intent();
            Bundle results = new Bundle();
            for (RemoteInput r : a.getRemoteInputs()) results.putCharSequence(r.getResultKey(), reply);
            RemoteInput.addResultsToIntent(a.getRemoteInputs(), fill, results);
            try {
                a.actionIntent.send(ctx, 0, fill);
                return true;
            } catch (Exception e) {
                return false;
            }
        }
        return false;
    }

    private static Notification.Action replyAction(Notification n) {
        if (n.actions == null) return null;
        for (Notification.Action a : n.actions) {
            RemoteInput[] r = a.getRemoteInputs();
            if (r == null) continue;
            for (RemoteInput i : r) if (i.getAllowFreeFormInput()) return a;
        }
        return null;
    }

    private static String appName(Context ctx, String pkg) {
        try {
            PackageManager pm = ctx.getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    private static String text(CharSequence c) {
        if (c == null) return "";
        String s = c.toString().trim();
        return s.length() > 300 ? s.substring(0, 299) + "…" : s;
    }
}
