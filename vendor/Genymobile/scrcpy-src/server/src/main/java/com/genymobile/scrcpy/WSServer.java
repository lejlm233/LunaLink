package com.genymobile.scrcpy;

import com.genymobile.scrcpy.control.ControlMessage;
import com.genymobile.scrcpy.control.ControlMessageReader;
import com.genymobile.scrcpy.device.DisplayInfo;
import com.genymobile.scrcpy.util.Ln;
import com.genymobile.scrcpy.wrappers.ServiceManager;

import org.java_websocket.WebSocket;
import org.java_websocket.framing.CloseFrame;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

import android.media.MediaCodecInfo;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileWriter;
import java.io.IOException;
import java.net.BindException;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;

/**
 * WebSocket server for ws-scrcpy.
 * Handles WebSocket connections and routes control messages to appropriate handlers.
 */
public class WSServer extends WebSocketServer {

    /**
     * Path to the PID file for process management.
     */
    public static final String PID_FILE_PATH = "/data/local/tmp/ws_scrcpy.pid";

    /**
     * Maps display IDs to their corresponding WebSocket connections.
     */
    private static final HashMap<Integer, WebSocketConnection> STREAM_BY_DISPLAY_ID = new HashMap<>();

    /**
     * In-progress file pushes keyed by push id.
     */
    private static final HashMap<Short, PushStream> PUSH_STREAMS = new HashMap<>();

    /**
     * State of an in-progress file push.
     */
    private static final class PushStream {
        private final String fileName;
        private final long fileSize;
        private final FileOutputStream out;
        private long written;

        private PushStream(String fileName, long fileSize, FileOutputStream out) {
            this.fileName = fileName;
            this.fileSize = fileSize;
            this.out = out;
        }
    }

    /**
     * Server options containing configuration parameters.
     */
    private final Options options;

    /**
     * Internal class to manage client socket information.
     */
    public static class SocketInfo {
        /**
         * Set of client IDs currently in use.
         */
        private static final HashSet<Short> INSTANCES_BY_ID = new HashSet<>();

        /**
         * Unique client identifier.
         */
        private final short clientId;

        /**
         * Reference to the WebSocket connection.
         */
        private WebSocketConnection connection;

        /**
         * Creates a new SocketInfo with an auto-assigned client ID.
         */
        public SocketInfo() {
            this.clientId = getNextClientId();
            INSTANCES_BY_ID.add(this.clientId);
        }

        /**
         * Gets the client ID.
         *
         * @return The client ID
         */
        public short getClientId() {
            return clientId;
        }

        /**
         * Gets the WebSocket connection.
         *
         * @return The WebSocket connection
         */
        public WebSocketConnection getConnection() {
            return connection;
        }

        /**
         * Sets the WebSocket connection.
         *
         * @param connection The WebSocket connection to set
         */
        public void setConnection(WebSocketConnection connection) {
            this.connection = connection;
        }

        /**
         * Releases this client ID from the pool.
         */
        public void release() {
            INSTANCES_BY_ID.remove(this.clientId);
        }

        /**
         * Gets the next available client ID.
         *
         * @return The next available client ID
         */
        private static synchronized short getNextClientId() {
            short id = 0;
            while (INSTANCES_BY_ID.contains(id)) {
                id++;
                if (id < 0) {
                    // Overflow protection
                    id = 0;
                    break;
                }
            }
            return id;
        }

        /**
         * Gets the count of active client instances.
         *
         * @return The number of active clients
         */
        public static int getActiveCount() {
            return INSTANCES_BY_ID.size();
        }
    }

    /**
     * Creates a new WebSocket server with the specified options.
     *
     * @param options Server configuration options
     */
    public WSServer(Options options) {
        super(new InetSocketAddress(
                options.getListenOnAllInterfaces() ? "0.0.0.0" : "127.0.0.1",
                options.getPortNumber()
        ));
        // 允许 TIME_WAIT 状态下重新绑定端口，避免 server 快速重启时 Address already in use
        setReuseAddr(true);
        this.options = options;
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        SocketInfo socketInfo = new SocketInfo();
        conn.setAttachment(socketInfo);

        Ln.i("WebSocket client connected: " + conn.getRemoteSocketAddress()
                + " (clientId=" + socketInfo.getClientId() + ")");

        // Send initial information to the client
        sendInitialInfo(conn);
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        SocketInfo socketInfo = conn.getAttachment();
        if (socketInfo != null) {
            Ln.i("WebSocket client disconnected: clientId=" + socketInfo.getClientId()
                    + ", code=" + code + ", reason=" + reason);

            // Clean up the connection
            leave(conn);
            socketInfo.release();
        }
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        Ln.w("Received unexpected text message from client: " + message);
    }

    @Override
    public void onMessage(WebSocket conn, ByteBuffer buffer) {
        SocketInfo socketInfo = conn.getAttachment();
        if (socketInfo == null) {
            Ln.w("Received message from unknown client");
            return;
        }

        try {
            processControlMessage(conn, socketInfo, buffer);
        } catch (IOException e) {
            Ln.e("Error processing control message", e);
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        if (ex instanceof BindException) {
            Ln.e("Failed to bind WebSocket server: " + ex.getMessage());
            Ln.e("Port " + options.getPortNumber() + " may already be in use");
        } else {
            String clientInfo = conn != null ? conn.getRemoteSocketAddress().toString() : "unknown";
            Ln.e("WebSocket error for client " + clientInfo, ex);
        }
    }

    @Override
    public void onStart() {
        Ln.i("WebSocket server started on port " + getPort());
        setConnectionLostTimeout(30);

        // Write PID file
        writePidFile();
    }

    /**
     * Processes a binary control message from a client.
     *
     * @param conn       The WebSocket connection
     * @param socketInfo The socket information
     * @param buffer     The message buffer
     * @throws IOException If an I/O error occurs
     */
    private void processControlMessage(WebSocket conn, SocketInfo socketInfo, ByteBuffer buffer)
            throws IOException {
        byte[] data = new byte[buffer.remaining()];
        buffer.get(data);

        // Compatibility: ws-scrcpy 1.x clients send a single-byte type=12 message to request a
        // key frame. In official scrcpy v3.x, type 12 is TYPE_UHID_CREATE which requires more
        // bytes, so a lone [12] must be ignored instead of being parsed (which would crash).
        if (data.length == 1 && data[0] == ControlMessage.TYPE_UHID_CREATE) {
            Ln.d("Ignored legacy key frame request (type=12, single byte)");
            return;
        }

        // PUSH_FILE uses the ws-scrcpy custom layout [id2][state1][...] which does NOT match
        // the official ControlMessageReader.parsePushFile() ([len4][data]), so it must be
        // parsed directly from raw bytes before handing off to the reader.
        if (data.length > 0 && data[0] == ControlMessage.TYPE_PUSH_FILE) {
            handlePushFileRaw(conn, socketInfo, data);
            return;
        }

        ByteArrayInputStream bais = new ByteArrayInputStream(data);
        ControlMessageReader reader = new ControlMessageReader(bais);
        ControlMessage msg = reader.read();

        switch (msg.getType()) {
            case ControlMessage.TYPE_CHANGE_STREAM_PARAMETERS:
                handleChangeStreamParameters(conn, socketInfo, msg);
                break;
            default:
                // Forward other messages to the connection's controller
                WebSocketConnection connection = socketInfo.getConnection();
                if (connection != null) {
                    connection.handleControlMessage(msg);
                } else {
                    Ln.w("No active connection for client " + socketInfo.getClientId()
                            + ", dropping message type " + msg.getType());
                }
                break;
        }
    }

    /**
     * Handles a change stream parameters message.
     *
     * @param conn       The WebSocket connection
     * @param socketInfo The socket information
     * @param msg        The control message
     */
    private void handleChangeStreamParameters(WebSocket conn, SocketInfo socketInfo, ControlMessage msg) {
        VideoSettings newSettings = msg.getVideoSettings();
        if (newSettings == null) {
            Ln.w("Received null video settings");
            return;
        }

        int displayId = newSettings.getDisplayId();
        Ln.d("Change stream parameters requested for display " + displayId);

        // Join or update stream for the specified display
        joinStreamForDisplayId(conn, newSettings, options, displayId, this);
    }

    /**
     * Handles a push file message (ws-scrcpy custom streaming protocol).
     * Wire format: [type=102][id(int16)][state(int8)][...]
     * <ul>
     *   <li>START(1): + [fileSize(uint32)][nameLen(uint16)][fileName]</li>
     *   <li>APPEND(2): + [chunkLen(uint32)][chunk]</li>
     *   <li>FINISH(3) / CANCEL(4) / NEW(0): no extra fields</li>
     * </ul>
     * Files are written to /data/local/tmp/. A PUSH_RESPONSE device message is sent on
     * completion using the client's expected format: scrcpy_message + [101][id(int16)][code(int8)].
     *
     * @param conn       The WebSocket connection
     * @param socketInfo The socket information
     * @param data       The raw control message bytes (including the type byte)
     */
    private void handlePushFileRaw(WebSocket conn, SocketInfo socketInfo, byte[] data) {
        if (data.length < 4) {
            Ln.w("Malformed push file message: " + data.length + " bytes");
            return;
        }
        short id = (short) (((data[1] & 0xFF) << 8) | (data[2] & 0xFF));
        byte state = data[3];

        try {
            switch (state) {
                case 1: // START
                    handlePushStart(conn, id, data);
                    break;
                case 2: // APPEND
                    handlePushAppend(conn, id, data);
                    break;
                case 3: // FINISH
                    handlePushFinish(conn, id);
                    break;
                case 4: // CANCEL
                    handlePushCancel(conn, id);
                    break;
                default:
                    Ln.w("Unknown push state: " + state + " (id=" + id + ")");
                    sendPushResponse(conn, id, (byte) -8); // ERROR_INVALID_STATE
                    break;
            }
        } catch (Exception e) {
            Ln.e("File push failed (id=" + id + ")", e);
            sendPushResponse(conn, id, (byte) -12); // ERROR_OTHER
        }
    }

    private void handlePushStart(WebSocket conn, short id, byte[] data) throws IOException {
        if (data.length < 11) {
            Ln.w("Malformed push START message (id=" + id + ")");
            sendPushResponse(conn, id, (byte) -1); // ERROR_INVALID_NAME
            return;
        }
        long fileSize = ((long) (data[4] & 0xFF) << 24) | ((data[5] & 0xFF) << 16) | ((data[6] & 0xFF) << 8) | (data[7] & 0xFF);
        int nameLen = ((data[8] & 0xFF) << 8) | (data[9] & 0xFF);
        if (nameLen <= 0 || data.length < 10 + nameLen) {
            Ln.w("Invalid file name length: " + nameLen + " (id=" + id + ")");
            sendPushResponse(conn, id, (byte) -1); // ERROR_INVALID_NAME
            return;
        }
        String fileName = new String(data, 10, nameLen, StandardCharsets.UTF_8);
        // Strip any path components for safety, keep only the base name
        int slash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
        if (slash >= 0) {
            fileName = fileName.substring(slash + 1);
        }
        if (fileName.isEmpty() || fileName.contains("..")) {
            sendPushResponse(conn, id, (byte) -1); // ERROR_INVALID_NAME
            return;
        }

        // Remove a stale stream with the same id if any
        PushStream old = PUSH_STREAMS.remove(id);
        if (old != null) {
            try {
                old.out.close();
            } catch (IOException e) {
                // Ignore
            }
        }

        File outFile = new File("/data/local/tmp/ws_push_" + id + "_" + fileName);
        FileOutputStream out = new FileOutputStream(outFile);
        PushStream stream = new PushStream(fileName, fileSize, out);
        PUSH_STREAMS.put(id, stream);
        Ln.i("Push START: id=" + id + ", file=" + fileName + ", size=" + fileSize);
    }

    private void handlePushAppend(WebSocket conn, short id, byte[] data) throws IOException {
        PushStream stream = PUSH_STREAMS.get(id);
        if (stream == null) {
            Ln.w("Push APPEND for unknown id: " + id);
            sendPushResponse(conn, id, (byte) -9); // ERROR_UNKNOWN_ID
            return;
        }
        if (data.length < 8) {
            sendPushResponse(conn, id, (byte) -6); // ERROR_FAILED_TO_WRITE
            return;
        }
        int chunkLen = ((data[4] & 0xFF) << 24) | ((data[5] & 0xFF) << 16) | ((data[6] & 0xFF) << 8) | (data[7] & 0xFF);
        if (chunkLen > 0) {
            if (data.length < 8 + chunkLen) {
                Ln.w("Push APPEND chunk truncated (id=" + id + ")");
                sendPushResponse(conn, id, (byte) -6); // ERROR_FAILED_TO_WRITE
                return;
            }
            stream.out.write(data, 8, chunkLen);
            stream.written += chunkLen;
        }
        Ln.d("Push APPEND: id=" + id + ", chunk=" + chunkLen + ", total=" + stream.written + "/" + stream.fileSize);
    }

    private void handlePushFinish(WebSocket conn, short id) throws IOException {
        PushStream stream = PUSH_STREAMS.remove(id);
        if (stream == null) {
            Ln.w("Push FINISH for unknown id: " + id);
            sendPushResponse(conn, id, (byte) -9); // ERROR_UNKNOWN_ID
            return;
        }
        stream.out.flush();
        stream.out.close();
        if (stream.written != stream.fileSize) {
            Ln.w("Push FINISH size mismatch: id=" + id + ", written=" + stream.written + ", expected=" + stream.fileSize);
        }
        Ln.i("Push FINISH: id=" + id + ", file=" + stream.fileName + ", " + stream.written + " bytes saved to /data/local/tmp/");
        sendPushResponse(conn, id, (byte) 0); // NO_ERROR
    }

    private void handlePushCancel(WebSocket conn, short id) {
        PushStream stream = PUSH_STREAMS.remove(id);
        if (stream == null) {
            Ln.w("Push CANCEL for unknown id: " + id);
            sendPushResponse(conn, id, (byte) -9); // ERROR_UNKNOWN_ID
            return;
        }
        try {
            stream.out.close();
        } catch (IOException e) {
            // Ignore
        }
        File f = new File("/data/local/tmp/ws_push_" + id + "_" + stream.fileName);
        if (f.exists()) {
            f.delete();
        }
        Ln.i("Push CANCEL: id=" + id + ", file deleted");
        sendPushResponse(conn, id, (byte) -3); // ERROR_FAILED_TO_DELETE (keeps client bookkeeping consistent)
    }

    /**
     * Sends a push response device message to the client.
     * Format: "scrcpy_message" + [type=101][id(int16)][code(int8)]
     */
    private void sendPushResponse(WebSocket conn, short id, byte code) {
        try {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            DataOutputStream dos = new DataOutputStream(baos);
            dos.write("scrcpy_message".getBytes(StandardCharsets.UTF_8));
            dos.writeByte(101); // TYPE_PUSH_RESPONSE
            dos.writeShort(id);
            dos.writeByte(code);
            dos.flush();
            conn.send(baos.toByteArray());
            Ln.d("Sent push response: id=" + id + ", code=" + code);
        } catch (Exception e) {
            Ln.e("Failed to send push response", e);
        }
    }

    /**
     * Sends initial information to a newly connected client.
     *
     * @param conn The WebSocket connection
     */
    private void sendInitialInfo(WebSocket conn) {
        try {
            SocketInfo socketInfo = conn.getAttachment();
            if (socketInfo == null) {
                return;
            }

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            DataOutputStream dos = new DataOutputStream(baos);

            // Magic bytes: "scrcpy_initial"
            dos.write("scrcpy_initial".getBytes(StandardCharsets.UTF_8));

            // Device name (64 bytes, padded with zeros)
            String deviceName = android.os.Build.MODEL;
            byte[] nameBytes = deviceName.getBytes(StandardCharsets.UTF_8);
            byte[] namePadded = new byte[64];
            System.arraycopy(nameBytes, 0, namePadded, 0, Math.min(nameBytes.length, 64));
            dos.write(namePadded);

            // Get display IDs
            int[] displayIds = ServiceManager.getDisplayManager().getDisplayIds();
            if (displayIds == null || displayIds.length == 0) {
                displayIds = new int[]{0}; // Default display
            }

            // Displays count
            dos.writeInt(displayIds.length);

            // For each display
            for (int displayId : displayIds) {
                DisplayInfo display = ServiceManager.getDisplayManager().getDisplayInfo(displayId);
                if (display == null) {
                    // Skip if display info not available
                    continue;
                }

                // DisplayInfo: displayId, width, height, rotation, layerStack, flags (24 bytes)
                dos.writeInt(display.getDisplayId());
                dos.writeInt(display.getSize().getWidth());
                dos.writeInt(display.getSize().getHeight());
                dos.writeInt(display.getRotation());
                dos.writeInt(display.getLayerStack());
                dos.writeInt(display.getFlags());

                // Connection count for this display
                WebSocketConnection existingConn = STREAM_BY_DISPLAY_ID.get(display.getDisplayId());
                int connectionCount = existingConn != null ? existingConn.getClientCount() : 0;
                dos.writeInt(connectionCount);

                // Screen info bytes count (0 for now - no active stream yet)
                dos.writeInt(0);

                // Video settings bytes count (0 for now - no active stream yet)
                dos.writeInt(0);
            }

            // Encoders list
            MediaCodecInfo[] encoders = ScreenEncoder.listEncoders();
            dos.writeInt(encoders.length);
            for (MediaCodecInfo encoder : encoders) {
                String encoderName = encoder.getName();
                byte[] encoderNameBytes = encoderName.getBytes(StandardCharsets.UTF_8);
                dos.writeInt(encoderNameBytes.length);
                dos.write(encoderNameBytes);
            }

            // Client ID
            dos.writeInt(socketInfo.getClientId());

            dos.flush();
            byte[] data = baos.toByteArray();
            conn.send(ByteBuffer.wrap(data));

            Ln.d("Sent initial info to client " + socketInfo.getClientId() + " (" + data.length + " bytes)");
        } catch (Exception e) {
            Ln.e("Failed to send initial info", e);
        }
    }

    /**
     * Sends initial information to all connected clients.
     */
    public void sendInitialInfoToAll() {
        for (WebSocket conn : getConnections()) {
            sendInitialInfo(conn);
        }
    }

    /**
     * Cleans up when a client leaves.
     *
     * @param conn The WebSocket connection
     */
    private void leave(WebSocket conn) {
        SocketInfo socketInfo = conn.getAttachment();
        if (socketInfo == null) {
            return;
        }

        WebSocketConnection connection = socketInfo.getConnection();
        if (connection != null) {
            try {
                connection.close();
            } catch (Exception e) {
                Ln.e("Error closing connection", e);
            }
            socketInfo.setConnection(null);
        }
    }

    /**
     * Gets the WebSocket connection for a specific display ID.
     *
     * @param displayId The display ID
     * @return The WebSocket connection, or null if not found
     */
    public static synchronized WebSocketConnection getConnectionForDisplay(int displayId) {
        return STREAM_BY_DISPLAY_ID.get(displayId);
    }

    /**
     * Releases the WebSocket connection for a specific display ID.
     *
     * @param displayId The display ID
     */
    public static synchronized void releaseConnectionForDisplay(int displayId) {
        WebSocketConnection connection = STREAM_BY_DISPLAY_ID.remove(displayId);
        if (connection != null) {
            Ln.d("Released connection for display " + displayId);
        }
    }

    /**
     * Joins or creates a stream for the specified display ID.
     *
     * @param conn          The WebSocket connection
     * @param videoSettings The video settings
     * @param options       The server options
     * @param displayId     The display ID
     * @param server        The WebSocket server instance
     */
    public static synchronized void joinStreamForDisplayId(
            WebSocket conn,
            VideoSettings videoSettings,
            Options options,
            int displayId,
            WSServer server) {

        SocketInfo socketInfo = conn.getAttachment();
        if (socketInfo == null) {
            Ln.w("Cannot join stream: no socket info");
            return;
        }

        WebSocketConnection existingConnection = STREAM_BY_DISPLAY_ID.get(displayId);

        if (existingConnection != null) {
            // Join existing stream
            Ln.d("Joining existing stream for display " + displayId);
            existingConnection.addClient(conn);
            socketInfo.setConnection(existingConnection);

            // Update video settings if changed
            existingConnection.setVideoSettings(videoSettings);
        } else {
            // Create new stream
            Ln.d("Creating new stream for display " + displayId);
            WebSocketConnection newConnection = new WebSocketConnection(options, videoSettings);
            newConnection.addClient(conn);
            socketInfo.setConnection(newConnection);
            STREAM_BY_DISPLAY_ID.put(displayId, newConnection);

            // Start the stream
            try {
                newConnection.start();
            } catch (Exception e) {
                Ln.e("Failed to start stream for display " + displayId, e);
                STREAM_BY_DISPLAY_ID.remove(displayId);
            }
        }
    }

    /**
     * Writes the current process PID to a file.
     */
    public static void writePidFile() {
        try {
            int pid = android.os.Process.myPid();
            File pidFile = new File(PID_FILE_PATH);
            try (FileWriter writer = new FileWriter(pidFile)) {
                writer.write(String.valueOf(pid));
            }
            Ln.d("PID file written: " + pid);
        } catch (IOException e) {
            Ln.w("Failed to write PID file", e);
        }
    }

    /**
     * Deletes the PID file.
     */
    public static void unlinkPidFile() {
        File pidFile = new File(PID_FILE_PATH);
        if (pidFile.exists()) {
            if (pidFile.delete()) {
                Ln.d("PID file deleted");
            } else {
                Ln.w("Failed to delete PID file");
            }
        }
    }

    /**
     * Gets the server options.
     *
     * @return The server options
     */
    public Options getOptions() {
        return options;
    }
}
