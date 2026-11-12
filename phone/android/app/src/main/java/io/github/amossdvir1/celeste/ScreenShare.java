package io.github.amossdvir1.celeste;

import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;

import com.getcapacitor.JSObject;

import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream;
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpTransceiver;
import org.webrtc.ScreenCapturerAndroid;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;
import org.webrtc.DataChannel;

import java.util.List;

/**
 * This phone's screen, live, on the computer (docs/PHONE_PLAN.md 7.3): Android's screen capture (the person says yes in
 * Android's own dialog, every time) feeds a WebRTC video track, and the computer answers the offer. The offer and the
 * answer travel as sealed calls through the app's own connection (the web part makes them), so this class only does the
 * capture and the peer connection.
 *
 * What it will not show: Android keeps windows marked secure (a bank app's) out of the capture on its own; and while an app on
 * Celeste's never list (or the person's own) is on the screen, or Celeste cannot tell what is on the screen, the video goes
 * black, checked four times a second. Android also ends the capture when the screen locks, and shows its own sharing chip.
 */
final class ScreenShare {
    interface Result {
        void offer(String sdp);

        void fail(String why);
    }

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static PeerConnectionFactory factory;
    private static EglBase egl;
    private static PeerConnection pc;
    private static ScreenCapturerAndroid capturer;
    private static SurfaceTextureHelper helper;
    private static VideoSource source;
    private static VideoTrack track;
    private static Runnable gate;
    private static volatile boolean active;

    static final String EXTRA_ASKED = "share_asked";

    private ScreenShare() {}

    /**
     * "Show phone screen" was pressed on the computer. With the app on screen the app's own stream has the same push and asks at
     * once; otherwise this is a notification, and opening it brings the app up to ask. Android's dialog cannot be skipped by any
     * app, so the person always says yes there.
     */
    static void asked(Context ctx) {
        if (MainActivity.visible) return;
        ConnectionService.channels(ctx);
        Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(EXTRA_ASKED, true);
        android.app.PendingIntent go = android.app.PendingIntent.getActivity(ctx, 7403, open, android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
        androidx.core.app.NotificationCompat.Builder b = new androidx.core.app.NotificationCompat.Builder(ctx, ConnectionService.CHANNEL_ASK)
                .setSmallIcon(R.drawable.ic_stat_celeste)
                .setColor(0xFFF5487F)
                .setContentTitle("Show this screen on your computer?")
                .setContentText("Tap to continue. Android will ask you to allow it.")
                .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(go);
        try {
            ctx.getSystemService(android.app.NotificationManager.class).notify(7403, b.build());
        } catch (SecurityException ignored) {
            // Notifications are off for Celeste.
        }
    }

    static boolean active() {
        return active;
    }

    /** An SdpObserver that cares about one outcome. */
    private abstract static class Sdp implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription d) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String e) {}
        @Override public void onSetFailure(String e) {}
    }

    /** Starts capturing with the permission Android just gave and makes the offer (with its addresses gathered). */
    static synchronized void start(Context ctx, Intent permission, List<PeerConnection.IceServer> servers, Result done) {
        stop(false, null);
        Context app = ctx.getApplicationContext();
        try {
            if (factory == null) {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(app).createInitializationOptions());
                egl = EglBase.create();
                factory = PeerConnectionFactory.builder()
                        .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(), true, true))
                        .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext()))
                        .createPeerConnectionFactory();
            }
            capturer = new ScreenCapturerAndroid(permission, new MediaProjection.Callback() {
                @Override public void onStop() {
                    // The person ended it from Android's chip, the screen locked, or another app started a capture.
                    ended("Android stopped sharing the screen.");
                }
            });
            helper = SurfaceTextureHelper.create("celeste-capture", egl.getEglBaseContext());
            source = factory.createVideoSource(true);
            capturer.initialize(helper, app, source.getCapturerObserver());
            // Up to 1280 on the long side: plenty to follow what is happening, and light on the phone's battery and data.
            DisplayMetrics dm = app.getResources().getDisplayMetrics();
            float scale = Math.min(1f, 1280f / Math.max(dm.widthPixels, dm.heightPixels));
            capturer.startCapture(Math.max(2, Math.round(dm.widthPixels * scale / 2) * 2), Math.max(2, Math.round(dm.heightPixels * scale / 2) * 2), 30);
            track = factory.createVideoTrack("celeste-screen", source);
            PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(servers);
            cfg.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
            final boolean[] offered = {false};
            final Runnable[] finish = new Runnable[1];
            pc = factory.createPeerConnection(cfg, new PeerConnection.Observer() {
                @Override public void onSignalingChange(PeerConnection.SignalingState s) {}
                @Override public void onIceConnectionChange(PeerConnection.IceConnectionState s) {}
                @Override public void onIceConnectionReceivingChange(boolean b) {}
                @Override public void onIceGatheringChange(PeerConnection.IceGatheringState s) {
                    if (s == PeerConnection.IceGatheringState.COMPLETE && finish[0] != null) main.post(finish[0]);
                }
                @Override public void onIceCandidate(IceCandidate c) {}
                @Override public void onIceCandidatesRemoved(IceCandidate[] c) {}
                @Override public void onAddStream(MediaStream s) {}
                @Override public void onRemoveStream(MediaStream s) {}
                @Override public void onDataChannel(DataChannel d) {}
                @Override public void onRenegotiationNeeded() {}
                @Override public void onConnectionChange(PeerConnection.PeerConnectionState s) {
                    if (s == PeerConnection.PeerConnectionState.FAILED || s == PeerConnection.PeerConnectionState.CLOSED) ended("The connection to the computer was lost.");
                }
            });
            if (pc == null) throw new IllegalStateException("No peer connection");
            pc.addTransceiver(track, new RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_ONLY));
            final PeerConnection mine = pc;
            finish[0] = () -> {
                if (offered[0] || pc != mine) return;
                offered[0] = true;
                SessionDescription d = mine.getLocalDescription();
                if (d == null) done.fail("The screen could not be shared.");
                else {
                    watch(app);
                    done.offer(d.description);
                }
            };
            pc.createOffer(new Sdp() {
                @Override public void onCreateSuccess(SessionDescription d) {
                    mine.setLocalDescription(new Sdp() {
                        @Override public void onSetSuccess() {
                            // The offer carries every address it found, or those found within a few seconds.
                            main.postDelayed(finish[0], 5000);
                        }
                        @Override public void onSetFailure(String e) {
                            stop(false, null);
                            done.fail("The screen could not be shared.");
                        }
                    }, d);
                }
                @Override public void onCreateFailure(String e) {
                    stop(false, null);
                    done.fail("The screen could not be shared.");
                }
            }, new MediaConstraints());
            active = true;
        } catch (Throwable e) {
            stop(false, null);
            done.fail("The screen could not be shared: " + e.getMessage());
        }
    }

    /** The computer's answer to the offer. */
    static synchronized void answer(String sdp) {
        PeerConnection p = pc;
        if (p == null) return;
        p.setRemoteDescription(new Sdp() {
            @Override public void onSetFailure(String e) {
                ended("The computer could not take the picture.");
            }
        }, new SessionDescription(SessionDescription.Type.ANSWER, sdp));
    }

    /** Black while an app on a never list is on the screen, or when Celeste cannot tell what is: checked four times a second. */
    private static void watch(Context app) {
        if (gate != null) main.removeCallbacks(gate);
        gate = new Runnable() {
            @Override public void run() {
                VideoTrack t = track;
                if (t == null) return;
                CelesteAccessibilityService s = CelesteAccessibilityService.live;
                String fg = s != null ? s.foregroundPackage() : null;
                t.setEnabled(fg != null && !PhoneControl.never(app, fg));
                main.postDelayed(this, 250);
            }
        };
        main.post(gate);
    }

    /** Capture ended on its own: tell the app, and let go of everything. */
    private static void ended(String why) {
        stop(true, why);
    }

    /** Lets go of the capture and the connection. `tell`: say so to the app (it may be showing "sharing"). */
    static synchronized void stop(boolean tell, String why) {
        boolean was = active || pc != null || capturer != null;
        active = false;
        if (gate != null) main.removeCallbacks(gate);
        gate = null;
        try {
            if (pc != null) pc.close();
        } catch (Throwable ignored) {
        }
        pc = null;
        try {
            if (capturer != null) {
                capturer.stopCapture();
                capturer.dispose();
            }
        } catch (Throwable ignored) {
        }
        capturer = null;
        if (track != null) track.dispose();
        track = null;
        if (source != null) source.dispose();
        source = null;
        if (helper != null) helper.dispose();
        helper = null;
        ScreenShareService.halt();
        if (tell && was) {
            CelesteNativePlugin p = CelesteNativePlugin.live;
            if (p != null) {
                JSObject o = new JSObject();
                o.put("why", why == null ? "" : why);
                p.shareEnded(o);
            }
        }
    }
}
