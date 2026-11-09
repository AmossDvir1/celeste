package io.github.amossdvir1.celeste;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Keeps Celeste connected with the app closed, when the person switched on "Stay connected". Android pauses the app's
 * web view in the background, so this service holds its own encrypted line to the computer, shows approvals and
 * questions as notifications, and sends Approve or Deny itself (ApprovalReceiver). A quiet notification says it is on.
 */
public class ConnectionService extends Service {
    static final String CHANNEL_QUIET = "connection";
    static final String CHANNEL_ASK = "approvals";
    private static final int ID = 7701;

    private volatile boolean running;
    private Thread thread;
    private volatile HttpURLConnection current;
    private final Map<String, String> titles = new HashMap<>();

    static void channels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL_QUIET) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_QUIET, "Connection to your computer", NotificationManager.IMPORTANCE_MIN);
            ch.setDescription("Shown while Celeste stays connected with the app closed.");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel(CHANNEL_ASK) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ASK, "Approvals and questions", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("When Celeste needs your answer.");
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        channels(this);
        PhoneLine line = PhoneLine.load(this);
        String computer = line != null ? line.computer : "your computer";
        Notification n = new NotificationCompat.Builder(this, CHANNEL_QUIET)
                .setSmallIcon(R.drawable.ic_stat_celeste)
                .setColor(0xFFF5487F)
                .setContentTitle("Celeste")
                .setContentText("Connected to " + computer)
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setContentIntent(openApp(this, 0))
                .build();
        ServiceCompat.startForeground(this, ID, n, Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING : 0);
        if (line != null && (thread == null || !thread.isAlive())) {
            running = true;
            thread = new Thread(() -> listen(line), "celeste-line");
            thread.start();
        }
        return START_NOT_STICKY;
    }

    static PendingIntent openApp(Context ctx, int request) {
        Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(ctx, request, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void listen(PhoneLine line) {
        long delay = 1000;
        while (running) {
            try {
                HttpURLConnection h = line.openEvents();
                current = h;
                int code = h.getResponseCode();
                if (code == 401) return; // This phone was removed on the computer.
                delay = 1000;
                BufferedReader r = new BufferedReader(new InputStreamReader(h.getInputStream(), StandardCharsets.UTF_8));
                StringBuilder data = new StringBuilder();
                for (String s; running && (s = r.readLine()) != null; ) {
                    if (s.startsWith("data: ")) data.append(s.substring(6));
                    else if (s.isEmpty() && data.length() > 0) {
                        handle(line, data.toString());
                        data.setLength(0);
                    }
                }
            } catch (Exception e) {
                // Dropped, or the computer is asleep: try again shortly.
            }
            try { Thread.sleep(delay); } catch (InterruptedException e) { return; }
            delay = Math.min(delay * 2, 30000);
        }
    }

    private void handle(PhoneLine line, String box) {
        try {
            JSONObject push = new JSONObject(line.open(box, PhoneLine.LABEL_PUSH));
            String type = push.optString("type");
            if ("summary".equals(type)) {
                JSONObject s = push.getJSONObject("session");
                titles.put(s.optString("id"), s.optString("title"));
                return;
            }
            // The computer asks the phone to do something: a card for the person, even while the app is on screen.
            if ("phoneCancel".equals(type)) {
                cancelled(this, push);
                return;
            }
            if ("phoneRequest".equals(type)) {
                Abilities.onRequest(this, line, push.getJSONObject("request"));
                return;
            }
            if (!"event".equals(type)) return;
            // While the app is on screen it shows these itself.
            if (MainActivity.visible) return;
            String sessionId = push.optString("sessionId");
            JSONObject e = push.getJSONObject("stored").getJSONObject("event");
            String kind = e.optString("type");
            String chat = titles.containsKey(sessionId) ? titles.get(sessionId) : "Celeste";
            if ("approval.requested".equals(kind)) {
                String requestId = e.optString("requestId");
                String detail = e.optString("detail", "");
                notifyApproval(this, sessionId, requestId, chat, e.optString("title") + (detail.isEmpty() ? "" : ": " + detail));
            } else if ("ask_user.requested".equals(kind)) {
                JSONArray qs = e.optJSONArray("questions");
                String q = qs != null && qs.length() > 0 ? qs.getJSONObject(0).optString("question") : "Celeste has a question for you.";
                show(this, e.optString("requestId").hashCode(), chat, q, null, null);
            } else if ("approval.resolved".equals(kind) || "ask.answered".equals(kind)) {
                // Answered somewhere else (the computer, or the app): the notification goes.
                getSystemService(NotificationManager.class).cancel(e.optString("requestId").hashCode());
            }
        } catch (Exception e) {
            // A push that does not open is dropped, never shown.
        }
    }

    /** Stop was pressed in the chat on the computer: its cards go, and phone control ends. */
    static void cancelled(Context ctx, JSONObject push) {
        JSONArray ids = push.optJSONArray("ids");
        if (ids != null) for (int i = 0; i < ids.length(); i++) Cards.forget(ctx, ids.optString(i));
        if (push.optBoolean("endControl")) PhoneControl.end(ctx, "The user pressed Stop in the chat on the computer.");
    }

    static void notifyApproval(Context ctx, String sessionId, String requestId, String chat, String text) {
        show(ctx, requestId.hashCode(), chat, text, action(ctx, sessionId, requestId, false), action(ctx, sessionId, requestId, true));
    }

    private static PendingIntent action(Context ctx, String sessionId, String requestId, boolean allow) {
        Intent i = new Intent(ctx, ApprovalReceiver.class)
                .setAction(allow ? "allow" : "deny")
                .putExtra("sessionId", sessionId)
                .putExtra("requestId", requestId)
                .putExtra("allow", allow);
        return PendingIntent.getBroadcast(ctx, (requestId + allow).hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void show(Context ctx, int id, String title, String text, PendingIntent deny, PendingIntent allow) {
        channels(ctx);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ASK)
                .setSmallIcon(R.drawable.ic_stat_celeste)
                .setColor(0xFFF5487F)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setContentIntent(openApp(ctx, id));
        if (deny != null) b.addAction(0, "Deny", deny);
        if (allow != null) b.addAction(0, "Approve", allow);
        try {
            ctx.getSystemService(NotificationManager.class).notify(id, b.build());
        } catch (SecurityException ignored) {
            // Notifications are off for Celeste.
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        HttpURLConnection h = current;
        if (h != null) new Thread(h::disconnect).start();
        if (thread != null) thread.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
