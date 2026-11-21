package app.paperlite.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 前台服务：只做一件事——让进程活着，这样网页里的 WebSocket 在后台也能收消息。
 * 通知本身极为安静（IMPORTANCE_MIN、不显示角标），不打扰人。
 */
public class KeepAliveService extends Service {

    private static final String CH = "alive";
    private static final int ID = 41;

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            NotificationChannel ch = new NotificationChannel(CH, "保持连接", NotificationManager.IMPORTANCE_MIN);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CH)
                : new Notification.Builder(this);
        b.setContentTitle("纸鸢")
         .setContentText("保持在线，随时收消息")
         .setSmallIcon(R.mipmap.ic_launcher)
         .setOngoing(true);
        Notification n = b.build();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(ID, n);
            }
        } catch (Exception e) {
            try { startForeground(ID, n); } catch (Exception e2) { }
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
