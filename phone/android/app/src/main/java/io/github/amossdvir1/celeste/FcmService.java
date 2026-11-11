package io.github.amossdvir1.celeste;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

/**
 * What Firebase brings while the app is closed: one data message holding a single sealed box (src/shared/phone.ts,
 * `PhoneWake`) that only this phone's key opens. Google and the relay see a token and a block of bytes.
 *
 * The box is a notice (an approval or a question waiting for the person), a request for the phone to do something, or a
 * Stop that clears the cards. Each is shown once however many ways it arrives: the app's own stream may carry the same.
 */
public class FcmService extends FirebaseMessagingService {
    @Override
    public void onNewToken(String token) {
        Push.register(this, token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        String box = message.getData().get("b");
        PhoneLine line = PhoneLine.load(this);
        if (box == null || line == null) return;
        try {
            JSONObject wake = new JSONObject(line.open(box, PhoneLine.LABEL_PUSH));
            switch (wake.optString("type")) {
                case "notify": {
                    // While the app is on screen it shows these itself.
                    if (MainActivity.visible) return;
                    String id = wake.getString("id");
                    String sessionId = wake.optString("sessionId");
                    String chat = wake.optString("chat", "Celeste");
                    String text = wake.optString("text");
                    if ("approval".equals(wake.optString("kind"))) ConnectionService.notifyApproval(this, sessionId, id, chat, text);
                    else ConnectionService.show(this, id.hashCode(), chat, text, null, null);
                    return;
                }
                case "phoneRequest":
                    Abilities.onRequest(this, line, wake.getJSONObject("request"));
                    return;
                case "phoneCancel":
                    ConnectionService.cancelled(this, wake);
                    return;
                default:
            }
        } catch (Exception e) {
            // A message that does not open is dropped, never shown.
        }
    }
}
