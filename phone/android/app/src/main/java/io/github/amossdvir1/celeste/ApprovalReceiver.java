package io.github.amossdvir1.celeste;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONArray;
import org.json.JSONObject;

/** Approve or Deny pressed on a notification: the answer goes straight to the computer, sealed, without opening the app. */
public class ApprovalReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String sessionId = intent.getStringExtra("sessionId");
        String requestId = intent.getStringExtra("requestId");
        boolean allow = intent.getBooleanExtra("allow", false);
        PhoneLine line = PhoneLine.load(ctx);
        if (sessionId == null || requestId == null || line == null) return;
        PendingResult pending = goAsync();
        new Thread(() -> {
            NotificationManager nm = ctx.getSystemService(NotificationManager.class);
            try {
                line.call("sessions.respondApproval", new JSONArray().put(sessionId).put(requestId).put(new JSONObject().put("allow", allow)));
                nm.cancel(requestId.hashCode());
            } catch (Exception e) {
                ConnectionService.show(ctx, requestId.hashCode(), "Celeste", "Your answer did not reach " + line.computer + ". Open Celeste to answer.", null, null);
            } finally {
                pending.finish();
            }
        }).start();
    }
}
