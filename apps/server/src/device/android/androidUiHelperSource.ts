/**
 * Source of Ryco's resident Android UI tree reader, compiled on first use by
 * `androidUiHelper.ts` (javac + d8 from the user's SDK) and run with
 * `app_process` as the shell user.
 *
 * It borrows the system's own `uiautomator.jar` wrapper to connect a
 * UiAutomation, then answers one request per stdin line ("d" dumps, "q"
 * quits) with one line of uiautomator-format XML. Staying resident skips the
 * JVM start, the connection and `uiautomator dump`'s one-second idle wait:
 * about 2 ms per read instead of about 2 s.
 *
 * Kept as a string so the server bundle carries it without a packaging step.
 *
 * @module device/android/androidUiHelperSource
 */
export const ANDROID_UI_HELPER_CLASS = "dev.ryco.UiHelper";

export const ANDROID_UI_HELPER_SOURCE = String.raw`package dev.ryco;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Method;

/** Ryco's resident Android UI tree reader. One request per stdin line; one XML line back. */
public final class UiHelper {
    private static final int MAX_NODES = 4000;
    private static int count;

    public static void main(String[] args) throws Exception {
        PrintStream out = new PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), false, "UTF-8");
        Class<?> wrapperClass = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
        Object wrapper = wrapperClass.getConstructor().newInstance();
        wrapperClass.getMethod("connect").invoke(wrapper);
        try {
            Method compressed = null;
            for (Method m : wrapperClass.getMethods()) {
                if (m.getName().startsWith("setCompressedLayoutHei") || m.getName().startsWith("setCompressedLayoutHie")) compressed = m;
            }
            if (compressed != null) compressed.invoke(wrapper, true);
        } catch (Throwable ignored) {
        }
        UiAutomation automation = (UiAutomation) wrapperClass.getMethod("getUiAutomation").invoke(wrapper);
        out.println("READY");
        out.flush();
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
        String line;
        while ((line = in.readLine()) != null) {
            line = line.trim();
            if (line.equals("q")) break;
            if (!line.equals("d")) continue;
            StringBuilder xml = new StringBuilder(64 * 1024);
            try {
                AccessibilityNodeInfo root = null;
                for (int attempt = 0; attempt < 5 && root == null; attempt++) {
                    root = automation.getRootInActiveWindow();
                    if (root == null) Thread.sleep(50);
                }
                count = 0;
                xml.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"");
                xml.append(rotation());
                xml.append("\">");
                if (root != null) dump(root, 0, xml);
                xml.append("</hierarchy>");
                out.println(xml.toString().replace('\n', ' ').replace('\r', ' '));
            } catch (Throwable error) {
                out.println("E " + String.valueOf(error).replace('\n', ' '));
            }
            out.flush();
        }
        wrapperClass.getMethod("disconnect").invoke(wrapper);
        System.exit(0);
    }

    private static int rotation() {
        try {
            Class<?> wm = Class.forName("android.view.WindowManagerGlobal");
            Object service = wm.getMethod("getWindowManagerService").invoke(null);
            Object value = service.getClass().getMethod("getDefaultDisplayRotation").invoke(service);
            return (Integer) value;
        } catch (Throwable ignored) {
            return 0;
        }
    }

    private static void dump(AccessibilityNodeInfo node, int index, StringBuilder xml) {
        if (++count > MAX_NODES) return;
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        xml.append("<node index=\"").append(index).append('"');
        attr(xml, "text", node.getText());
        attr(xml, "resource-id", node.getViewIdResourceName());
        attr(xml, "class", node.getClassName());
        attr(xml, "package", node.getPackageName());
        attr(xml, "content-desc", node.getContentDescription());
        if (android.os.Build.VERSION.SDK_INT >= 26) attr(xml, "hint", node.getHintText());
        if (android.os.Build.VERSION.SDK_INT >= 30) attr(xml, "state-description", node.getStateDescription());
        flag(xml, "checkable", node.isCheckable());
        flag(xml, "checked", node.isChecked());
        flag(xml, "clickable", node.isClickable());
        flag(xml, "enabled", node.isEnabled());
        flag(xml, "focusable", node.isFocusable());
        flag(xml, "focused", node.isFocused());
        flag(xml, "scrollable", node.isScrollable());
        flag(xml, "long-clickable", node.isLongClickable());
        flag(xml, "password", node.isPassword());
        flag(xml, "selected", node.isSelected());
        flag(xml, "editable", node.isEditable());
        xml.append(" bounds=\"[").append(bounds.left).append(',').append(bounds.top).append("][")
            .append(bounds.right).append(',').append(bounds.bottom).append("]\"");
        int children = node.getChildCount();
        boolean open = false;
        for (int i = 0; i < children; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            if (child.isVisibleToUser()) {
                if (!open) {
                    xml.append('>');
                    open = true;
                }
                dump(child, i, xml);
            }
        }
        xml.append(open ? "</node>" : " />");
    }

    private static void flag(StringBuilder xml, String name, boolean value) {
        xml.append(' ').append(name).append("=\"").append(value).append('"');
    }

    private static void attr(StringBuilder xml, String name, CharSequence value) {
        xml.append(' ').append(name).append("=\"");
        if (value != null) {
            String text = value.toString();
            for (int i = 0; i < text.length() && i < 2000; i++) {
                char c = text.charAt(i);
                switch (c) {
                    case '&': xml.append("&amp;"); break;
                    case '<': xml.append("&lt;"); break;
                    case '>': xml.append("&gt;"); break;
                    case '"': xml.append("&quot;"); break;
                    case '\n': xml.append("&#10;"); break;
                    case '\r': xml.append("&#13;"); break;
                    case '\t': xml.append("&#9;"); break;
                    default:
                        if (c < 0x20) xml.append(' ');
                        else xml.append(c);
                }
            }
        }
        xml.append('"');
    }
}
`;
