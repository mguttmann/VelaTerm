package com.velaterm.mobile;

import android.app.Dialog;
import android.view.View;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.filters.SdkSuppress;
import com.velaterm.remote.ConnectionRecoveryView;
import com.velaterm.remote.MobileText;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Collections;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
/** Runs the production WebView and coordinator against an explicitly supplied local TLS service. */
@RunWith(AndroidJUnit4.class)
@SdkSuppress(minSdkVersion = 29)
public class TrustPromptIntegrationTest {
    private Object plugin;
    private String target;
    private String text(String key) { return new MobileText(InstrumentationRegistry.getInstrumentation().getTargetContext()).get(key, Collections.emptyMap()); }
    private Object call(String name, Class<?>[] types, Object... args) throws Exception {
        Method method = plugin.getClass().getDeclaredMethod(name, types); method.setAccessible(true); return method.invoke(plugin, args);
    }
    private Object field(String name) throws Exception { Field f = plugin.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(plugin); }
    private void main(Checked operation) throws Exception {
        AtomicReference<Throwable> error = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { try { operation.run(); } catch (Throwable failure) { error.set(failure); } });
        if (error.get() != null) throw new AssertionError(error.get());
    }
    private interface Checked { void run() throws Exception; }
    private interface Probe { boolean ready() throws Exception; }
    private void waitFor(String label, Probe probe) throws Exception {
        long end = System.currentTimeMillis() + 20000;
        while (System.currentTimeMillis() < end) { if (probe.ready()) return; Thread.sleep(100); }
        fail("Timed out waiting for " + label);
    }
    private View findText(View view, String expected) {
        if (view instanceof android.widget.TextView && expected.contentEquals(((android.widget.TextView) view).getText()) && view.isShown()) return view;
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) { View found = findText(group.getChildAt(i), expected); if (found != null) return found; }
        }
        return null;
    }
    private View visibleText(String key) throws Exception {
        AtomicReference<View> result = new AtomicReference<>();
        main(() -> {
            for (View root : android.view.inspector.WindowInspector.getGlobalWindowViews()) {
                View found = findText(root, text(key)); if (found != null) result.set(found);
            }
        });
        return result.get();
    }
    private void prompt(String key) throws Exception { waitFor("trust prompt", () -> visibleText(key) != null); }
    private void tap(String key) throws Exception {
        View button = visibleText(key); assertNotNull(button); main(() -> assertTrue(button.performClick()));
    }
    private JSONObject keys() throws Exception { return ((JSONObject) call("readStore", new Class<?>[]{})).getJSONObject("keys"); }
    private void open() throws Exception {
        main(() -> {
            Field f = plugin.getClass().getDeclaredField("activeId"); f.setAccessible(true); f.set(plugin, "trust-fixture");
            call("showBrowser", new Class<?>[]{String.class, String.class, String.class}, target, "", "TLS fixture");
        });
    }
    private void fixture(boolean changed, Checked scenario) throws Exception {
        target = InstrumentationRegistry.getArguments().getString("trustUrl");
        org.junit.Assume.assumeTrue("Requires the isolated TLS fixture", target != null && !target.isEmpty());
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            activity.onActivity(value -> plugin = value.getBridge().getPlugin("VelaRemote").getInstance());
            JSONObject original = (JSONObject) call("readStore", new Class<?>[]{});
            try {
                JSONObject row = new JSONObject().put("id", "trust-fixture").put("name", "TLS fixture").put("mode", "url").put("url", target);
                JSONObject trust = new JSONObject();
                if (changed) trust.put("tls:" + target.replaceAll("/$", ""), "SHA256:previous");
                call("writeStore", new Class<?>[]{JSONObject.class}, new JSONObject().put("connections", new JSONArray().put(row)).put("keys", trust));
                open(); scenario.run();
            } finally {
                main(() -> { Dialog dialog = (Dialog) field("browser"); if (dialog != null) dialog.dismiss(); });
                call("writeStore", new Class<?>[]{JSONObject.class}, original);
            }
        }
    }
    private void ready() throws Exception {
        waitFor("page readiness", () -> {
            AtomicReference<Boolean> visible = new AtomicReference<>(false);
            main(() -> { View recovery = (View) field("recovery"); visible.set(recovery != null && recovery.getVisibility() == View.GONE); });
            return visible.get();
        });
    }
    @Test public void acceptsAndLoadsThenReusesThePin() throws Exception {
        fixture(false, () -> {
            prompt("mobile.native.trustTitle");
            tap("mobile.native.trustAccept"); ready();
            assertEquals(1, keys().length());
            open(); ready(); assertNull(visibleText("mobile.native.trustTitle"));
        });
    }
    @Test public void refusalDoesNotRepeatAndExplicitRetryCanTrust() throws Exception {
        fixture(false, () -> {
            prompt("mobile.native.trustTitle"); tap("common.cancel");
            waitFor("refusal page", () -> visibleText("mobile.native.certificateRejected") != null);
            Thread.sleep(700); assertNull(visibleText("mobile.native.trustTitle")); assertEquals(0, keys().length());
            main(() -> ((ConnectionRecoveryView) field("recovery")).getRetryButton().performClick());
            prompt("mobile.native.trustTitle"); tap("mobile.native.trustAccept"); ready(); assertEquals(1, keys().length());
        });
    }
    @Test public void generationChangeDismissesPendingTrustWithoutPersisting() throws Exception {
        fixture(false, () -> {
            prompt("mobile.native.trustTitle"); main(() -> call("advanceGeneration", new Class<?>[]{}));
            Thread.sleep(700); assertNull(visibleText("mobile.native.trustTitle")); assertEquals(0, keys().length());
        });
    }
    @Test public void changedFingerprintNeedsAnotherExplicitDecision() throws Exception {
        fixture(true, () -> {
            prompt("mobile.native.trustChangedTitle"); tap("common.cancel");
            assertEquals("SHA256:previous", keys().getString("tls:" + target.replaceAll("/$", "")));
        });
    }
    @Test public void retiredWebViewCannotCancelTheNewTrustPrompt() throws Exception {
        fixture(false, () -> {
            prompt("mobile.native.trustTitle");
            AtomicReference<android.webkit.WebView> retired = new AtomicReference<>();
            AtomicReference<android.webkit.WebViewClient> callbacks = new AtomicReference<>();
            main(() -> {
                retired.set((android.webkit.WebView) field("web"));
                callbacks.set(retired.get().getWebViewClient());
            });
            open(); prompt("mobile.native.trustTitle");
            main(() -> assertTrue(callbacks.get().onRenderProcessGone(retired.get(), new android.webkit.RenderProcessGoneDetail() {
                @Override public boolean didCrash() { return true; }
                @Override public int rendererPriorityAtExit() { return android.webkit.WebView.RENDERER_PRIORITY_IMPORTANT; }
            })));
            assertNotNull(visibleText("mobile.native.trustTitle"));
            tap("mobile.native.trustAccept"); ready(); assertEquals(1, keys().length());
        });
    }
}
