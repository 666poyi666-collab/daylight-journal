package com.daylight.journal;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.HttpURLConnection;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "JournalDiscovery")
public class JournalDiscoveryPlugin extends Plugin {
    private static final String SERVICE_TYPE = "_poyi-journal._tcp.";
    private static final long DISCOVERY_TIMEOUT_MS = 8_000;

    @PluginMethod
    public void discover(PluginCall call) {
        NsdManager manager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
        if (manager == null) {
            call.reject("当前设备不支持局域网服务发现");
            return;
        }

        Handler handler = new Handler(Looper.getMainLooper());
        AtomicBoolean completed = new AtomicBoolean(false);
        NsdManager.DiscoveryListener[] listenerRef = new NsdManager.DiscoveryListener[1];
        ExecutorService scanner = Executors.newFixedThreadPool(24);

        Runnable finishNotFound = () -> {
            if (!completed.compareAndSet(false, true)) return;
            scanner.shutdownNow();
            stopDiscovery(manager, listenerRef[0]);
            call.reject("未发现同步服务，请确认电脑与手机连接同一局域网");
        };

        NsdManager.ResolveListener resolveListener = new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                // Discovery may return transient records; keep listening until timeout.
            }

            @Override
            public void onServiceResolved(NsdServiceInfo serviceInfo) {
                String address = preferredAddress(serviceInfo);
                if (address == null || !completed.compareAndSet(false, true)) return;
                handler.removeCallbacks(finishNotFound);
                scanner.shutdownNow();
                stopDiscovery(manager, listenerRef[0]);

                String host = address.contains(":") ? "[" + address + "]" : address;
                JSObject result = new JSObject();
                result.put("name", serviceInfo.getServiceName());
                result.put("url", "http://" + host + ":" + serviceInfo.getPort());
                call.resolve(result);
            }
        };

        NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
            @Override
            public void onDiscoveryStarted(String serviceType) {}

            @Override
            public void onServiceFound(NsdServiceInfo serviceInfo) {
                if (SERVICE_TYPE.equals(serviceInfo.getServiceType())) {
                    manager.resolveService(serviceInfo, resolveListener);
                }
            }

            @Override
            public void onServiceLost(NsdServiceInfo serviceInfo) {}

            @Override
            public void onDiscoveryStopped(String serviceType) {}

            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                finishNotFound.run();
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {}
        };
        listenerRef[0] = listener;

        handler.postDelayed(finishNotFound, DISCOVERY_TIMEOUT_MS);
        manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener);
        discoverBySubnet(call, completed, handler, finishNotFound, manager, listenerRef, scanner);
    }

    private static String preferredAddress(NsdServiceInfo serviceInfo) {
        if (android.os.Build.VERSION.SDK_INT >= 34) {
            List<InetAddress> addresses = serviceInfo.getHostAddresses();
            for (InetAddress address : addresses) {
                if (address instanceof Inet4Address && !address.isLoopbackAddress()) {
                    return address.getHostAddress();
                }
            }
            if (!addresses.isEmpty()) return addresses.get(0).getHostAddress();
        }
        InetAddress host = serviceInfo.getHost();
        return host == null ? null : host.getHostAddress();
    }

    private static void stopDiscovery(
        NsdManager manager,
        NsdManager.DiscoveryListener listener
    ) {
        if (listener == null) return;
        try {
            manager.stopServiceDiscovery(listener);
        } catch (IllegalArgumentException ignored) {
            // The system already stopped a discovery session that failed to start.
        }
    }

    private static void discoverBySubnet(
        PluginCall call,
        AtomicBoolean completed,
        Handler handler,
        Runnable finishNotFound,
        NsdManager manager,
        NsdManager.DiscoveryListener[] listenerRef,
        ExecutorService scanner
    ) {
        String prefix = privateIpv4Prefix();
        if (prefix == null) return;
        for (int suffix = 1; suffix < 255; suffix++) {
            String address = prefix + suffix;
            scanner.execute(() -> {
                if (completed.get() || !isJournalService(address)) return;
                if (!completed.compareAndSet(false, true)) return;
                handler.removeCallbacks(finishNotFound);
                scanner.shutdownNow();
                stopDiscovery(manager, listenerRef[0]);

                JSObject result = new JSObject();
                result.put("name", "Journal Sync API");
                result.put("url", "http://" + address + ":8781");
                call.resolve(result);
            });
        }
    }

    private static String privateIpv4Prefix() {
        try {
            for (NetworkInterface network : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!network.getName().startsWith("wlan")) continue;
                String prefix = privateIpv4Prefix(network);
                if (prefix != null) return prefix;
            }
        } catch (Exception ignored) {
            return null;
        }
        return null;
    }

    private static String privateIpv4Prefix(NetworkInterface network) throws Exception {
        if (!network.isUp() || network.isLoopback()) return null;
        for (InetAddress address : Collections.list(network.getInetAddresses())) {
            if (!(address instanceof Inet4Address) || !address.isSiteLocalAddress()) continue;
            String value = address.getHostAddress();
            int lastDot = value.lastIndexOf('.');
            if (lastDot > 0) return value.substring(0, lastDot + 1);
        }
        return null;
    }

    private static boolean isJournalService(String address) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(
                "http://" + address + ":8781/healthz"
            ).openConnection();
            connection.setConnectTimeout(500);
            connection.setReadTimeout(500);
            connection.setUseCaches(false);
            if (connection.getResponseCode() != 200) return false;
            byte[] body = new byte[256];
            int count = connection.getInputStream().read(body);
            return count > 0 && new String(body, 0, count, StandardCharsets.UTF_8).contains(
                "\"service\":\"Journal Sync API\""
            );
        } catch (Exception ignored) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
