package io.github.amossdvir1.celeste;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.List;
import java.util.Locale;

/**
 * Phone abilities (docs/PHONE_PLAN.md, step A2): the computer asks, through the encrypted line, for something to be done
 * here. Each ability must be switched on in the app; each request (except "status") is shown to the person as a card,
 * and nothing happens unless they press Allow. Allow opens AbilityActivity, which does it and answers the computer.
 */
final class Abilities {
    static final String[] ALL = {"notifications", "open", "alarm", "location", "files", "calendar", "messages", "control"};
    private static final String PREFS = "celeste-abilities";
    private static final ArrayDeque<String> SEEN = new ArrayDeque<>();

    private Abilities() {}

    /** The switch in the app that covers an ability. */
    static String group(String ability) {
        switch (ability) {
            case "notification_reply":
            case "notification_dismiss": return "notifications";
            case "photos": return "files";
            case "calendar_add": return "calendar";
            case "message":
            case "call": return "messages";
            default: return ability;
        }
    }

    static boolean enabled(Context ctx, String ability) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(group(ability), false);
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
            reply(line, id, false, ability.startsWith("notification_")
                    ? "That notification is no longer on the phone" + ("notification_reply".equals(ability) ? ", or it cannot be answered." : ".")
                    : "This phone cannot do that.");
            return;
        }
        int nid = id.hashCode();
        // Not NO_HISTORY: the activity may open a picker or ask for a permission, and must get the answer back.
        Intent allow = new Intent(ctx, AbilityActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
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
        switch (group(ability)) {
            case "notifications": return "Notifications";
            case "open": return "Open apps and links";
            case "alarm": return "Alarms and timers";
            case "location": return "Location";
            case "files": return "Photos and files";
            case "calendar": return "Calendar";
            case "messages": return "Texts and calls";
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
            case "notification_dismiss": {
                CelesteNotificationListener.Item n = CelesteNotificationListener.find(a.optString("key"));
                if (n == null) return null;
                return new String[]{"Clear a notification?", n.app + " · " + n.title};
            }
            case "location":
                return new String[]{"Share where this phone is?", "Celeste tells the assistant this phone’s location now, once."};
            case "photos": {
                int max = a.optInt("max", 10);
                return new String[]{"Pick photos for Celeste?", "You choose which (up to " + max + "). Smaller copies go to Celeste on your computer."};
            }
            case "files": {
                int max = a.optInt("max", 10);
                return new String[]{"Pick files for Celeste?", "You choose which (up to " + max + "). Copies go to Celeste on your computer."};
            }
            case "calendar": {
                int days = a.optInt("days", 7);
                String from = a.has("from") ? "from " + a.optString("from") : "from today";
                return new String[]{"Let Celeste read your calendar?", "Your events for " + days + (days == 1 ? " day " : " days ") + from + ": titles, times and places."};
            }
            case "calendar_add": {
                String when = a.optString("start").replace('T', ' ');
                if (a.has("end")) when += " – " + a.optString("end").replace('T', ' ');
                if (a.has("location")) when += " · " + a.optString("location");
                return new String[]{"Add “" + a.optString("title") + "” to your calendar?", when};
            }
            case "message":
                return new String[]{"Write a text to " + a.optString("to") + "?", "“" + a.optString("text") + "”\nYour messaging app opens with it; you press Send."};
            case "call":
                return new String[]{"Call " + a.optString("to") + "?", "Your phone app opens with the number; you press Call."};
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

    /** All the files for one request together, as the computer takes them (PHONE_ATTACH_MAX_BYTES). */
    static final long MAX_BYTES = 40L * 1_048_576;
    /** Bytes in one part (PHONE_ATTACH_PART). */
    private static final int PART = 1_048_576;

    /** A file the person picked, copied into the app's cache to be sent. */
    static final class Outgoing {
        final File file;
        final String name, mime;

        Outgoing(File file, String name, String mime) {
            this.file = file;
            this.name = name;
            this.mime = mime;
        }
    }

    /** Sends the files to the computer one after another, each in parts, then the answer; the copies go after. Off the main thread. */
    static void replyFiles(PhoneLine line, String id, String text, List<Outgoing> files, File folder) {
        new Thread(() -> {
            int sent = 0;
            String note = "";
            try {
                if (line == null) return;
                byte[] buf = new byte[PART];
                for (int i = 0; i < files.size(); i++) {
                    Outgoing f = files.get(i);
                    long size = f.file.length(), done = 0;
                    try (InputStream in = new FileInputStream(f.file)) {
                        for (int part = 0; ; part++) {
                            int n = readFully(in, buf);
                            done += n;
                            boolean last = done >= size || n < PART;
                            JSONObject p = new JSONObject().put("id", id).put("file", i).put("name", f.name).put("mime", f.mime).put("part", part)
                                    .put("data", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)).put("last", last);
                            line.call("phone.attach", new JSONArray().put(p));
                            if (last) break;
                        }
                    }
                    sent++;
                }
            } catch (Exception e) {
                note = " Only " + sent + " of " + files.size() + " reached the computer: " + e.getMessage();
            } finally {
                deleteAll(folder);
            }
            if (line == null) return;
            try {
                line.call("phone.reply", new JSONArray().put(new JSONObject().put("id", id).put("ok", sent > 0).put("text", text + note)));
            } catch (Exception ignored) {
                // The computer will time the request out.
            }
        }, "celeste-files").start();
    }

    private static int readFully(InputStream in, byte[] buf) throws Exception {
        int n = 0;
        for (int r; n < buf.length && (r = in.read(buf, n, buf.length - n)) > 0; ) n += r;
        return n;
    }

    static void deleteAll(File f) {
        File[] inside = f.listFiles();
        if (inside != null) for (File c : inside) deleteAll(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
