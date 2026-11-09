package io.github.amossdvir1.celeste;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Locale;

/**
 * Phone abilities (docs/PHONE_PLAN.md, step A2): the computer asks, through the encrypted line, for something to be done
 * here. Each ability must be switched on in the app; each request (except "status") is shown to the person as a card,
 * and nothing happens unless they press Allow. Allow opens AbilityActivity, which does it and answers the computer.
 */
final class Abilities {
    static final String[] ALL = {"notifications", "open", "alarm", "control"};
    private static final String PREFS = "celeste-abilities";
    private static final ArrayDeque<String> SEEN = new ArrayDeque<>();

    private Abilities() {}

    static boolean enabled(Context ctx, String ability) {
        String group = "notification_reply".equals(ability) ? "notifications" : ability;
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(group, false);
    }

    static void set(Context ctx, String ability, boolean on) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ability, on).apply();
    }

    /** Ask again before buttons like Send or Pay. Off by default, so the one grant covers the whole task. */
    static boolean controlConfirm(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("control_confirm", false);
    }

    /** The apps the person added to the never list: Celeste never reads their notifications or touches their screens. */
    static java.util.Set<String> neverApps(Context ctx) {
        return new java.util.HashSet<>(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getStringSet("never", java.util.Collections.emptySet()));
    }

    static void setNever(Context ctx, String pkg, boolean on) {
        java.util.Set<String> now = neverApps(ctx);
        if (on) now.add(pkg);
        else now.remove(pkg);
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet("never", now).apply();
    }

    /** The apps on the phone a person can open, by name, each marked if Celeste never uses it (and whether that is fixed). */
    static JSONArray apps(Context ctx) throws Exception {
        android.content.pm.PackageManager pm = ctx.getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        java.util.Set<String> mine = neverApps(ctx);
        java.util.TreeMap<String, JSONObject> byName = new java.util.TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        for (android.content.pm.ResolveInfo r : pm.queryIntentActivities(launcher, 0)) {
            String pkg = r.activityInfo.packageName;
            if (pkg.equals(ctx.getPackageName())) continue;
            String name = r.loadLabel(pm).toString();
            JSONObject o = new JSONObject().put("pkg", pkg).put("name", name)
                    .put("never", PhoneControl.NEVER.contains(pkg) || mine.contains(pkg)).put("fixed", PhoneControl.NEVER.contains(pkg));
            byName.put(name + "\u0000" + pkg, o);
        }
        JSONArray out = new JSONArray();
        for (JSONObject o : byName.values()) out.put(o);
        return out;
    }

    static JSONObject state(Context ctx) throws Exception {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject o = new JSONObject();
        for (String a : ALL) o.put(a, p.getBoolean(a, false));
        o.put("notificationAccess", CelesteNotificationListener.allowed(ctx));
        o.put("controlAccess", CelesteAccessibilityService.enabled(ctx));
        o.put("controlConfirm", controlConfirm(ctx));
        o.put("never", neverApps(ctx).size());
        return o;
    }

    /** Each request is handled once, even when the app and the background service both receive it. */
    private static synchronized boolean firstTime(String id) {
        if (SEEN.contains(id)) return false;
        SEEN.addLast(id);
        while (SEEN.size() > 50) SEEN.removeFirst();
        return true;
    }

    /** A request arrived from the computer. */
    static void onRequest(Context ctx, PhoneLine line, JSONObject request) {
        String id = request.optString("id");
        String ability = request.optString("ability");
        JSONObject args = request.optJSONObject("args");
        if (args == null) args = new JSONObject();
        if (id.isEmpty() || !firstTime(id)) return;
        // Tell the computer at once that the request arrived, so it never waits minutes on a phone that is not listening.
        ack(line, id);
        // Phone control has its own rules: one card for the grant, then none per action (PhoneControl).
        if (ability.startsWith("control_")) {
            PhoneControl.handle(ctx, line, request);
            return;
        }
        if ("status".equals(ability)) {
            reply(line, id, true, statusText(ctx));
            return;
        }
        if (!enabled(ctx, ability)) {
            reply(line, id, false, "The user has not switched on “" + label(ability) + "” in the Celeste app on their phone (This phone tab).");
            return;
        }
        String chat = request.optString("chat", "a chat");
        String[] card = describe(ctx, ability, args);
        if (card == null) {
            reply(line, id, false, "That notification is no longer on the phone, or it cannot be answered.");
            return;
        }
        int nid = id.hashCode();
        Intent allow = new Intent(ctx, AbilityActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_HISTORY | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
                .putExtra("request", request.toString());
        Intent deny = new Intent(ctx, AbilityReceiver.class).setAction("deny").putExtra("id", id);
        PendingIntent allowPi = PendingIntent.getActivity(ctx, nid, allow, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent denyPi = PendingIntent.getBroadcast(ctx, nid + 1, deny, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        boolean shown = Cards.show(ctx, id, card[0], card[1] + "\nFor “" + chat + "”.", denyPi, allowPi, (c, yes) -> {
            // Answered in the app: the app is on screen, so it may open the activity that does the work.
            if (yes) c.startActivity(allow);
            else reply(line, id, false, "The user said no on their phone.");
        });
        if (!shown) reply(line, id, false, UNSEEN);
    }

    static final String UNSEEN = "The phone could not show the user the request: notifications are off for Celeste on the phone, and the app is not open. Ask the user to open Celeste on the phone, or to allow its notifications.";

    /** Tells the computer the request arrived. */
    static void ack(PhoneLine line, String id) {
        if (line == null) return;
        new Thread(() -> {
            try {
                line.call("phone.ack", new JSONArray().put(new JSONObject().put("id", id)));
            } catch (Exception ignored) {
                // The reply will say what happened.
            }
        }, "celeste-ack").start();
    }

    static String label(String ability) {
        switch (ability) {
            case "notifications":
            case "notification_reply": return "Notifications";
            case "open": return "Open apps and links";
            case "alarm": return "Alarms and timers";
            case "control": return "Phone control";
            default: return ability;
        }
    }

    /** The card's title and text, in the person's words. Null when the request cannot be shown honestly. */
    static String[] describe(Context ctx, String ability, JSONObject a) {
        switch (ability) {
            case "notifications":
                return new String[]{"Let Celeste read your notifications?", "It sees the app, title and text of each notification now on this phone."};
            case "notification_reply": {
                CelesteNotificationListener.Item n = CelesteNotificationListener.find(a.optString("key"));
                if (n == null || !n.canReply) return null;
                return new String[]{"Reply to " + n.title + "?", n.app + ": “" + a.optString("text") + "”"};
            }
            case "open":
                return a.has("url")
                        ? new String[]{"Open this link?", a.optString("url")}
                        : new String[]{"Open " + a.optString("app") + "?", "Celeste asks to open the app on this phone."};
            case "alarm":
                if (a.has("timerSeconds")) {
                    int s = a.optInt("timerSeconds");
                    String length = s % 60 == 0 ? (s / 60) + " min" : s + " s";
                    return new String[]{"Start a " + length + " timer?", a.optString("label", "A timer in your clock app.")};
                }
                return new String[]{String.format(Locale.US, "Set an alarm for %02d:%02d?", a.optInt("hour"), a.optInt("minute", 0)), a.optString("label", "An alarm in your clock app.")};
            default:
                return null;
        }
    }

    private static String statusText(Context ctx) {
        StringBuilder b = new StringBuilder("The phone is connected. Abilities the user switched on: ");
        boolean any = false;
        for (String a : ALL) {
            if (!enabled(ctx, a)) continue;
            b.append(any ? ", " : "").append(label(a));
            any = true;
        }
        if (!any) b.append("none");
        b.append(".");
        if (enabled(ctx, "notifications") && !CelesteNotificationListener.allowed(ctx)) b.append(" Notification access is still off in Android's settings.");
        return b.toString();
    }

    /** Answers with a screenshot (base64 JPEG, or null for none). */
    static void replyImage(PhoneLine line, String id, boolean ok, String text, String jpeg) {
        if (line == null) return;
        new Thread(() -> {
            try {
                JSONObject r = new JSONObject().put("id", id).put("ok", ok).put("text", text);
                if (jpeg != null) r.put("image", new JSONObject().put("mime", "image/jpeg").put("data", jpeg));
                line.call("phone.reply", new JSONArray().put(r));
            } catch (Exception ignored) {
                // The computer will time the request out.
            }
        }, "celeste-reply").start();
    }

    /** Answers the computer, off the main thread. */
    static void reply(PhoneLine line, String id, boolean ok, String text) {
        if (line == null) return;
        new Thread(() -> {
            try {
                line.call("phone.reply", new JSONArray().put(new JSONObject().put("id", id).put("ok", ok).put("text", text)));
            } catch (Exception ignored) {
                // The computer will time the request out.
            }
        }, "celeste-reply").start();
    }
}
