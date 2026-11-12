package io.github.amossdvir1.celeste;

import android.content.ClipData;
import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputConnectionWrapper;

import androidx.annotation.Nullable;
import androidx.core.view.ContentInfoCompat;
import androidx.core.view.OnReceiveContentListener;
import androidx.core.view.ViewCompat;
import androidx.core.view.inputmethod.EditorInfoCompat;
import androidx.core.view.inputmethod.InputConnectionCompat;

import com.getcapacitor.CapacitorWebView;

/**
 * The app's web view. It lets the message box take pictures and files the way a messaging app does:
 * <ul>
 * <li>the keyboard's clipboard (Gboard and others) offers copied pictures and files, and inserts the one the person picks, any
 * of them, through the editor's input connection, which has to say which types it takes;</li>
 * <li>a keyboard's own Paste button pastes what is on the clipboard, a file included (the web view's paste only knows text).</li>
 * </ul>
 * Both hand the files to the page (Pasted) as a "pasted" event. Text pastes as text, as always.
 */
public class CelesteWebView extends CapacitorWebView {
    public CelesteWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        ViewCompat.setOnReceiveContentListener(this, Pasted.TYPES, new OnReceiveContentListener() {
            @Nullable
            @Override
            public ContentInfoCompat onReceiveContent(View view, ContentInfoCompat payload) {
                ClipData clip = payload.getClip();
                Pasted.fromClip(getContext(), clip);
                // Everything was taken: nothing is left for the web view to try as text.
                return null;
            }
        });
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection ic = super.onCreateInputConnection(outAttrs);
        if (ic == null) return null;
        EditorInfoCompat.setContentMimeTypes(outAttrs, Pasted.TYPES);
        // A keyboard's own Paste button asks the editor to paste: when the clipboard holds a file, it goes to the page as a file.
        InputConnection withPaste = new InputConnectionWrapper(ic, true) {
            @Override
            public boolean performContextMenuAction(int id) {
                if ((id == android.R.id.paste || id == android.R.id.pasteAsPlainText) && Pasted.clipboardHasFiles(getContext())) {
                    Pasted.fromClipboard(getContext());
                    return true;
                }
                return super.performContextMenuAction(id);
            }
        };
        return InputConnectionCompat.createWrapper(this, withPaste, outAttrs);
    }
}
