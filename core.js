import axios from "axios";

const CORE_URL =
    process.env.CORE_URL ||
    "https://kenya-ultra-core-git-900495233478.europe-west1.run.app";

class KenyaUltraCore {

    constructor() {
        this.manifest = null;
        this.protocol = null;
    }

    async validate(sessionId) {

        try {

            const { data } = await axios.post(
                `${CORE_URL}/validate`,
                {
                    sessionId
                }
            );

            return {
                success: data.success,
                client: data.client,
                auth: data.auth,
                authRaw: data.authRaw
            };

        } catch (error) {

            throw new Error(
                error.response?.data?.message ||
                "Failed to validate SESSION_ID."
            );

        }

    }

    async getSettings(sessionId) {

        try {

            const { data } = await axios.get(
                `${CORE_URL}/settings/${sessionId}`
            );

            return {
                prefix: data.prefix || ".",
                mode: data.mode || "public",
                autoViewStatus: Boolean(data.autoViewStatus),
                autoReactStatus: Boolean(data.autoReactStatus),
                autoReactStatusEmoji: data.autoReactStatusEmoji || "💚",
                autoTyping: data.autoTyping || "off",
                autoRecording: data.autoRecording || "off"
            };

        } catch (error) {

            console.log(
                "Failed to fetch bot settings, using defaults:",
                error.response?.data?.message || error.message
            );

            return {
                prefix: ".",
                mode: "public"
            };

        }

    }

    async getGroupSettings(groupId) {

        try {

            const { data } = await axios.get(
                `${CORE_URL}/settings/group/${groupId}`
            );

            return data.settings || {};

        } catch (error) {

            console.log(
                "Failed to fetch group settings, using defaults:",
                error.response?.data?.message || error.message
            );

            return {};

        }

    }

    async syncAuth(sessionId, creds) {

        try {

            await axios.post(
                `${CORE_URL}/sync-auth`,
                { sessionId, creds }
            );

        } catch (error) {

            console.log(
                "⚠ Failed to sync auth creds to Core:",
                error.response?.data?.message || error.message
            );

        }

    }

    async execute(sessionId, message) {

        try {

            const { data } = await axios.post(
                `${CORE_URL}/execute`,
                {
                    sessionId,
                    message
                }
            );

            return data;

        } catch (error) {

            console.log("========== CORE ERROR ==========");
            console.dir(error.response?.data || error, {
                depth: null
            });
            console.log("================================");

            throw new Error(
                error.response?.data?.message ||
                error.message ||
                "Failed to execute command."
            );

        }

    }

    // Tells Core this session is alive — powers .stats' "connected
    // sessions" count. Call once on WhatsApp connect, then repeatedly
    // as a heartbeat (see index.js) since Core prunes sessions that
    // stop calling this rather than relying on a clean disconnect
    // signal, which crashes/force-stops never get the chance to send.
    // Best-effort: a failed heartbeat shouldn't take down the bot.
    async connect(sessionId) {

        try {

            const { data } = await axios.post(
                `${CORE_URL}/connect`,
                { sessionId }
            );

            return data;

        } catch (error) {

            console.log(
                "⚠ Failed to register connection with Core:",
                error.response?.data?.message || error.message
            );

            return null;

        }

    }

    async disconnect(sessionId) {

        try {

            const { data } = await axios.post(
                `${CORE_URL}/disconnect`,
                { sessionId }
            );

            return data;

        } catch {

            return null;

        }

    }

    async heartbeat() {

        try {

            const { data } = await axios.get(CORE_URL);

            return data;

        } catch {

            return null;

        }

    }

    async getVersion() {

        try {

            const { data } = await axios.get(`${CORE_URL}/version`);

            return data;

        } catch {

            return {
                success: false
            };

        }

    }

    async handshake() {

        const { data } =
            await axios.get(`${CORE_URL}/handshake`);

        this.protocol = data.protocol;

        return data;

    }

    async getManifest() {

        const { data } =
            await axios.get(`${CORE_URL}/manifest`);

        this.manifest = data;

        return data;

    }

    async getHealth() {

        const { data } =
            await axios.get(`${CORE_URL}/health`);

        return data;

    }

    async downloadCommands() {

        return `${CORE_URL}/commands/download`;

    }

    async bootstrap() {

        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("Connecting to Kenya-Ultra Core...");
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

        await this.handshake();

        const manifest =
            await this.getManifest();

        const health =
            await this.getHealth();

        console.log("✓ Handshake Complete");
        console.log(`✓ Protocol : v${manifest.protocol}`);
        console.log(`✓ Version  : ${manifest.version}`);
        console.log(`✓ Commands : ${manifest.commandCount}`);
        console.log(`✓ Runtime  : ${manifest.runtime}`);
        console.log(`✓ Status   : ${health.status}`);

        return {
            manifest,
            health
        };

    }

}

export default new KenyaUltraCore();
