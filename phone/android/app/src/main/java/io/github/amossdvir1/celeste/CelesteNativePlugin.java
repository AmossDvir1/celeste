package io.github.amossdvir1.celeste;

import android.content.Context;
import android.content.Intent;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * What the web part of the app cannot do itself: find Celeste on the Wi-Fi (mDNS, `_celeste._tcp`), read the name the
 * person gave the phone, and keep the app running while it is connected (a foreground service with a quiet notification).
 */
@CapacitorPlugin(name = "CelesteNative")
public class CelesteNativePlugin extends Plugin {
    private static final String SERVICE_TYPE = "_celeste._tcp";
    static volatile CelesteNativePlugin live;

    @Override
    public void load() {
        live = this;
    }

    /** The open cards changed: the app shows the first one as a sheet. */
    static void cardsChanged() {
        CelesteNativePlugin p = live;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("cards", Cards.list());
        p.notifyListeners("cards", o);
    }

    @PluginMethod
    public void cards(PluginCall call) {
        JSObject o = new JSObject();
        o.put("cards", Cards.list());
        call.resolve(o);
    }

    /** The person answered a card in the app. */
    @PluginMethod
    public void answerCard(PluginCall call) {
        String id = call.getString("id");
        if (id != null) Cards.answer(getContext(), id, Boolean.TRUE.equals(call.getBoolean("yes", false)));
        call.resolve();
    }

    /** Stop was pressed in the chat on the computer (the app's own stream got it). */
    @PluginMethod
    public void cancelRequests(PluginCall call) {
        try {
            ConnectionService.cancelled(getContext(), new org.json.JSONObject(call.getString("push", "{}")));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void discover(PluginCall call) {
        int ms = Math.max(1000, Math.min(15000, call.getInt("ms", 5000)));
        Context ctx = getContext();
        NsdManager nsd = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
        WifiManager wifi = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        // Some phones drop multicast packets unless an app asks to receive them.
        WifiManager.MulticastLock lock = wifi != null ? wifi.createMulticastLock("celeste-discovery") : null;
        if (lock != null) {
            lock.setReferenceCounted(false);
            lock.acquire();
        }
        List<NsdServiceInfo> seen = new ArrayList<>();
        Handler main = new Handler(Looper.getMainLooper());
        NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String type) {}
            @Override public void onDiscoveryStopped(String type) {}
            @Override public void onStartDiscoveryFailed(String type, int code) {}
            @Override public void onStopDiscoveryFailed(String type, int code) {}
            @Override public void onServiceLost(NsdServiceInfo info) {}
            @Override public void onServiceFound(NsdServiceInfo info) {
                synchronized (seen) {
                    for (NsdServiceInfo s : seen) if (s.getServiceName().equals(info.getServiceName())) return;
                    seen.add(info);
                }
            }
        };
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener);
        } catch (Exception e) {
            if (lock != null) lock.release();
            JSObject empty = new JSObject();
            empty.put("found", new JSArray());
            call.resolve(empty);
            return;
        }
        main.postDelayed(() -> {
            try { nsd.stopServiceDiscovery(listener); } catch (Exception ignored) {}
            ArrayDeque<NsdServiceInfo> queue;
            synchronized (seen) { queue = new ArrayDeque<>(seen); }
            JSArray found = new JSArray();
            resolveNext(nsd, queue, found, () -> {
                if (lock != null) lock.release();
                JSObject result = new JSObject();
                result.put("found", found);
                call.resolve(result);
            });
        }, ms);
    }

    /** NsdManager resolves one service at a time, so they are resolved in turn. */
    private void resolveNext(NsdManager nsd, ArrayDeque<NsdServiceInfo> queue, JSArray found, Runnable done) {
        NsdServiceInfo next = queue.poll();
        if (next == null) { done.run(); return; }
        Handler main = new Handler(Looper.getMainLooper());
        final boolean[] finished = {false};
        Runnable carryOn = () -> {
            if (finished[0]) return;
            finished[0] = true;
            main.post(() -> resolveNext(nsd, queue, found, done));
        };
        main.postDelayed(carryOn, 3000);
        try {
            nsd.resolveService(next, new NsdManager.ResolveListener() {
                @Override public void onResolveFailed(NsdServiceInfo info, int code) { carryOn.run(); }
                @Override public void onServiceResolved(NsdServiceInfo info) {
                    String host = ipv4(info);
                    if (host != null) {
                        JSObject o = new JSObject();
                        o.put("name", info.getServiceName());
                        o.put("host", host);
                        o.put("port", info.getPort());
                        Map<String, byte[]> attrs = info.getAttributes();
                        byte[] id = attrs != null ? attrs.get("id") : null;
                        if (id != null) o.put("id", new String(id, StandardCharsets.UTF_8));
                        synchronized (found) { found.put(o); }
                    }
                    carryOn.run();
                }
            });
        } catch (Exception e) {
            carryOn.run();
        }
    }

    private static String ipv4(NsdServiceInfo info) {
        if (Build.VERSION.SDK_INT >= 34) {
            for (InetAddress a : info.getHostAddresses()) if (a instanceof Inet4Address) return a.getHostAddress();
            return null;
        }
        InetAddress a = info.getHost();
        return a instanceof Inet4Address ? a.getHostAddress() : null;
    }

    @PluginMethod
    public void deviceName(PluginCall call) {
        String name = null;
        try { name = Settings.Global.getString(getContext().getContentResolver(), "device_name"); } catch (Exception ignored) {}
        if (name == null || name.trim().isEmpty()) {
            try { name = Settings.Secure.getString(getContext().getContentResolver(), "bluetooth_name"); } catch (Exception ignored) {}
        }
        if (name == null || name.trim().isEmpty()) name = Build.MODEL;
        JSObject o = new JSObject();
        o.put("name", name);
        call.resolve(o);
    }

    /** Starts the background line. `base`, `phoneId`, `computer` and `key` (the raw shared key, base64) are what it needs. */
    @PluginMethod
    public void startService(PluginCall call) {
        String base = call.getString("base"), phone = call.getString("phoneId"), key = call.getString("key");
        if (base == null || phone == null || key == null) {
            call.reject("Not paired.");
            return;
        }
        PhoneLine.save(getContext(), base, phone, call.getString("computer", "your computer"), key);
        Intent i = new Intent(getContext(), ConnectionService.class);
        getContext().stopService(i); // Picks up a new address if the computer moved.
        try {
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Android did not let Celeste stay connected: " + e.getMessage());
        }
    }

    /** Keeps the line's details (address, phone id, shared key) so phone abilities can answer the computer. */
    @PluginMethod
    public void setLine(PluginCall call) {
        String base = call.getString("base"), phone = call.getString("phoneId"), key = call.getString("key");
        if (base == null || phone == null || key == null) {
            call.reject("Not paired.");
            return;
        }
        PhoneLine.save(getContext(), base, phone, call.getString("computer", "your computer"), key);
        call.resolve();
    }

    /** A phone request that arrived on the app's own stream (the service handles the same one only once). */
    @PluginMethod
    public void handleRequest(PluginCall call) {
        try {
            Abilities.onRequest(getContext(), PhoneLine.load(getContext()), new org.json.JSONObject(call.getString("request", "{}")));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void abilities(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(Abilities.state(getContext())));
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void setAbility(PluginCall call) {
        String a = call.getString("ability");
        if (a == null) {
            call.reject("No ability");
            return;
        }
        Abilities.set(getContext(), a, Boolean.TRUE.equals(call.getBoolean("on", false)));
        call.resolve();
    }

    /** The phone's apps, for the never list. */
    @PluginMethod
    public void apps(PluginCall call) {
        new Thread(() -> {
            try {
                JSObject o = new JSObject();
                o.put("apps", new com.getcapacitor.JSArray(Abilities.apps(getContext()).toString()));
                call.resolve(o);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        }, "celeste-apps").start();
    }

    @PluginMethod
    public void setNever(PluginCall call) {
        String pkg = call.getString("pkg");
        if (pkg == null || PhoneControl.NEVER.contains(pkg)) {
            call.reject("That app is always off-limits.");
            return;
        }
        Abilities.setNever(getContext(), pkg, Boolean.TRUE.equals(call.getBoolean("on", false)));
        call.resolve();
    }

    /** Opens Android's Notification access page, at Celeste's own switch where Android allows it. */
    @PluginMethod
    public void openNotificationAccess(PluginCall call) {
        Intent i;
        if (Build.VERSION.SDK_INT >= 30) {
            i = new Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                    .putExtra(android.provider.Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, new android.content.ComponentName(getContext(), CelesteNotificationListener.class).flattenToString());
        } else i = new Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
        } catch (Exception e) {
            getContext().startActivity(new Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    /** Opens Android's Accessibility settings, where the person switches on Celeste phone control. */
    @PluginMethod
    public void openAccessibility(PluginCall call) {
        getContext().startActivity(new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }

    /** Opens Celeste's App info page, where Android's "Allow restricted settings" lives. */
    @PluginMethod
    public void openAppInfo(PluginCall call) {
        Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + getContext().getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /** Stops the background line. `forget` also removes its key, when the phone is disconnected. */
    @PluginMethod
    public void stopService(PluginCall call) {
        getContext().stopService(new Intent(getContext(), ConnectionService.class));
        if (Boolean.TRUE.equals(call.getBoolean("forget", false))) PhoneLine.clear(getContext());
        call.resolve();
    }
}
