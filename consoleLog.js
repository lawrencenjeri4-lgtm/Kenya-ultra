import chalk from "chalk";

const LABEL = chalk.hex("#FFA500"); // orange field labels
const BORDER = chalk.gray;
const VALUE = chalk.white;

function renderBox(title, titleColor, fields) {

    const lines = [];

    lines.push(
        BORDER("┌─「") + titleColor(title) + BORDER("」")
    );

    for (const [label, value] of fields) {

        lines.push(
            BORDER("» ") +
            LABEL(`${label}:`) +
            " " +
            VALUE(value ?? "—")
        );

    }

    lines.push(BORDER("└─○"));

    return lines.join("\n");

}

// Generic system/status box — use anywhere for a quick boxed log
// instead of a plain console.log line (reconnects, memory warnings,
// startup steps, etc.).
export function logSystem(info) {

    console.log(
        renderBox("🔧SYSTEM", chalk.yellow, [
            ["Info", info]
        ])
    );

}

export function logMemberJoined({
    name,
    number,
    userJid,
    groupName,
    groupJid
}) {

    console.log(
        renderBox("➕NEW MEMBER JOINED", chalk.green, [
            ["Name", name],
            ["Number", number],
            ["User JID", userJid],
            ["Group", groupName],
            ["Group JID", groupJid]
        ])
    );

}

export function logIncomingMessage({
    senderName,
    chatId,
    groupName,
    groupJid,
    messageType,
    text
}) {

    const now = new Date();

    const timeStr =
        now.toLocaleTimeString("en-US", {
            hour12: true,
            timeZone: "Africa/Nairobi"
        }) + " EAT";

    const dateStr =
        now.toLocaleDateString("en-GB", {
            timeZone: "Africa/Nairobi"
        });

    const fields = [
        ["Sent Time", timeStr],
        ["Date", dateStr],
        ["Message Type", messageType || "conversation"],
        ["Sender Name", senderName || "Unknown"],
        ["Chat ID", chatId]
    ];

    if (groupName) {
        fields.push(["Group", groupName]);
        fields.push(["Group JID", groupJid]);
    }

    fields.push(["Message", text || "(no text)"]);

    console.log(
        renderBox("🐺KENYA-ULTRA", chalk.cyan, fields)
    );

}
