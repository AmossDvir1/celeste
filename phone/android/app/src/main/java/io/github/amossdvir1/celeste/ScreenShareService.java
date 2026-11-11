package io.github.amossdvir1.celeste;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import org.json.JSONObject;
import org.webrtc.PeerConnection;

import java.util.ArrayList;
import java.util.List;

/**
 * Android requires a foreground service of type "mediaProjection" to be running before the screen can be captured (Android 14
 * and later), and shows the person a notification while it is. This is it: it starts when the person has said yes in
 * Android's dialog, hands the permission to ScreenShare, and ends with the sharing.
 */
public class ScreenShareService extends Service {
    private static final String CHANNEL = "screen-share";
    private static final int ID = 7402;
    private static volatile Intent permission;
    private static volatile List<PeerConnection.IceServer> servers;
    private static volatile PluginCall pending;
    private static volatile ScreenShareService live;

    /** The person said yes: start the service, which makes the offer and answers `call` with it. */
    static void begin(Context ctx, Intent grant, JSArray iceServers, PluginCall call) {
        permission = grant;
        servers = parse(iceServers);
        pending = call;
        ContextCompat.startForegroundService(ctx, new Intent(ctx, ScreenShareService.class));
    }

    private static List<PeerConnection.IceServer> parse(JSArray list) {
        List<PeerConnection.IceServer> out = new ArrayList<>();
        try {
            for (int i = 0; list != null && i < list.length(); i++) {
                JSONObject s = list.getJSONObject(i);
                List<String> urls = new ArrayList<>();
                for (int u = 0; u < s.getJSONArray("urls").length(); u++) urls.add(s.getJSONArray("urls").getString(u));
                PeerConnection.IceServer.Builder b = PeerConnection.IceServer.builder(urls);
                if (s.has("username")) b.setUsername(s.getString("username"));
                if (s.has("credential")) b.setPassword(s.getString("credential"));
                out.add(b.createIceServer());
            }
        } catch (Exception ignored) {
            // Whatever could be read is used.
        }
        return out;
    }

    static void halt() {
        ScreenShareService s = live;
        if (s != null) s.stopSelf();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        live = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Showing this screen on your computer", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Shown while this phone's screen is shared with your computer.");
                nm.createNotificationChannel(ch);
            }
        }
        PhoneLine line = PhoneLine.load(this);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_celeste)
                .setColor(0xFFF5487F)
                .setContentTitle("Celeste is showing this screen")
                .setContentText("on " + (line != null ? line.computer : "your computer"))
                .setOngoing(true)
                .setSilent(true)
                .setContentIntent(ConnectionService.openApp(this, 1))
                .build();
        ServiceCompat.startForeground(this, ID, n, Build.VERSION.SDK_INT >= 29 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION : 0);
        Intent grant = permission;
        PluginCall call = pending;
        permission = null;
        pending = null;
        if (grant == null || call == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        ScreenShare.start(this, grant, servers, new ScreenShare.Result() {
            @Override public void offer(String sdp) {
                JSObject o = new JSObject();
                o.put("sdp", sdp);
                call.resolve(o);
            }

            @Override public void fail(String why) {
                call.reject(why);
                stopSelf();
            }
        });
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (live == this) live = null;
        // The service going while a capture is on ends the capture.
        if (ScreenShare.active()) ScreenShare.stop(true, "Sharing ended.");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
