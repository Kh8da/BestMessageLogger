
import "./BestMessageLogger.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { TooltipContainer } from "@components/TooltipContainer";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import { ModalCloseButton, ModalContent, ModalHeader, ModalProps, ModalRoot, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import { findCssClassesLazy } from "@webpack";
import {
    ChannelStore,
    FluxDispatcher,
    Menu,
    MessageStore,
    Parser,
    SelectedChannelStore,
    TabBar,
    Text,
    Timestamp,
    Toasts,
    UserStore,
    showToast,
    useState,
    useStateFromStores
} from "@webpack/common";

type Snowflake = string;
type OverlayTab = "deleted" | "edited" | "ghostPings";

type BasicAuthor = {
    id?: string;
    username?: string;
    globalName?: string | null;
    avatar?: string | null;
    bot?: boolean;
};

type BasicAttachment = {
    id?: string;
    url?: string;
    proxy_url?: string;
    filename?: string;
    content_type?: string;
    deleted?: boolean;
};

type BasicMessage = {
    id?: string;
    channel_id?: string;
    guild_id?: string | null;
    content?: string;
    author?: BasicAuthor;
    mentions?: Array<{ id?: string; username?: string; }>;
    mention_everyone?: boolean;
    timestamp?: string;
    edited_timestamp?: string | null;
    attachments?: BasicAttachment[];
    embeds?: any[];
    flags?: number;
    deleted?: boolean;
    editHistory?: Array<{ timestamp: Date; content: string; }>;
    firstEditTimestamp?: Date;
    state?: string;
    type?: number;
    __bmlSynthetic?: boolean;
};

type OverlayAttachment = {
    id: string;
    url: string;
    filename: string;
    contentType: string;
    deleted?: boolean;
};

type OverlayMessage = {
    id: Snowflake;
    channelId: Snowflake;
    guildId: Snowflake | null;
    channelName: string | null;
    guildName: string | null;
    content: string;
    authorId: Snowflake | null;
    authorTag: string;
    isBot: boolean;
    mentionEveryone: boolean;
    mentions: Snowflake[];
    timestamp: string;
    editedTimestamp: string | null;
    attachments: OverlayAttachment[];
    embeds: Array<{
    type: string;
    url?: string;
    title?: string;
    image?: { url: string; };
    thumbnail?: { url: string; };
    video?: { url: string; };
}>;
    jumpHint: string;
};

type EditEntry = {
    messageId: Snowflake;
    channelId: Snowflake;
    guildId: Snowflake | null;
    before: OverlayMessage;
    after: OverlayMessage;
    editedAt: string;
    historyIndex: number;
};

type DeleteEntry = OverlayMessage & {
    deletedAt: string;
    kind: "delete" | "bulk-delete";
};

type GhostPingEntry = OverlayMessage & {
    detectedAt: string;
    reason: "deleted" | "edited";
};

type PersistedData = {
    deleted: DeleteEntry[];
    edited: EditEntry[];
    ghostPings: GhostPingEntry[];
};

type PluginApi = {
    version: string;
    open: () => void;
    close: () => void;
    toggle: () => void;
    dump: () => PersistedData;
    exportJson: () => string;
    downloadJson: () => void;
    clearAll: () => void;
};

const PLUGIN_NAME = "BestMessageLogger";
const VERSION = "2.0.0";
const STORAGE_KEY = "vc-best-message-logger-v2";
const BRAND_NAME = "Kh8da";
const BRAND_LINK = "https://guns.lol/Pxrsa";
const BRAND_AVATAR_URL = "https://i.imgur.com/pYOWTEu.jpeg";

const OVERLAY_CACHE = new Map<string, OverlayMessage>();
const EDIT_CACHE = new Map<string, OverlayMessage[]>();
const LIVE_MESSAGE_CACHE = new Map<string, any>();
const DELETED_ARCHIVE = new Map<string, any>();
const GHOST_DEDUPE = new Set<string>();

const authors = [
    { name: "Kh8da", id: 508044811345854495n }
];

const settings = definePluginSettings({
    deleteStyle: {
        type: OptionType.SELECT,
        description: "How deleted messages should look in chat.",
        default: "text",
        options: [
            { label: "Red text", value: "text", default: true },
            { label: "Red overlay", value: "overlay" }
        ]
    },
    logDeletes: {
        type: OptionType.BOOLEAN,
        description: "Keep deleted messages visible in chat and log them.",
        default: true
    },
    collapseDeleted: {
        type: OptionType.BOOLEAN,
        description: "Collapse deleted messages similarly to blocked messages.",
        default: false,
        restartNeeded: true
    },
    logEdits: {
        type: OptionType.BOOLEAN,
        description: "Track message edits.",
        default: true
    },
    inlineEdits: {
        type: OptionType.BOOLEAN,
        description: "Display edit history directly below messages in chat.",
        default: true
    },
    logGhostPings: {
        type: OptionType.BOOLEAN,
        description: "Track deleted/edited messages that pinged you.",
        default: true
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Ignore messages from bots.",
        default: false
    },
    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "Ignore your own messages.",
        default: false
    },
    ignoreUsers: {
        type: OptionType.STRING,
        description: "Comma-separated list of user IDs to ignore.",
        default: "",
        multiline: true
    },
    ignoreChannels: {
        type: OptionType.STRING,
        description: "Comma-separated list of channel IDs to ignore.",
        default: "",
        multiline: true
    },
    ignoreGuilds: {
        type: OptionType.STRING,
        description: "Comma-separated list of guild IDs to ignore.",
        default: "",
        multiline: true
    },
    savedLimit: {
        type: OptionType.SLIDER,
        description: "Maximum overlay entries per category.",
        default: 1000,
        markers: [100, 250, 500, 1000, 2500, 5000],
        stickToMarkers: false
    },
    retentionDays: {
        type: OptionType.SLIDER,
        description: "Auto-prune overlay entries older than this many days.",
        default: 30,
        markers: [1, 3, 7, 14, 30, 90],
        stickToMarkers: false
    },
    openHotkey: {
        type: OptionType.STRING,
        description: "Log menu hotkey, for example Ctrl+Shift+I",
        default: "Ctrl+Shift+I"
    }
});

const MessageClasses = findCssClassesLazy("edited", "communicationDisabled", "isSystemMessage");
const CodeContainerClasses = findCssClassesLazy("markup", "codeContainer");
const MiscClasses = findCssClassesLazy("messageContent", "markupRtl");
const modalCl = classNameFactory("vc-bml-modal-");

let overlayRoot: HTMLDivElement | null = null;
let overlayOpen = false;
let overlayTab: OverlayTab = "deleted";
let overlaySearch = "";
let overlaySelectedIndex = 0;
let hotkeyHandler: ((e: KeyboardEvent) => void) | null = null;
let ignoreNextSearchFocusRestore = false;
let overlaySelectedKey: string | null = null;

type OverlaySectionMode = "all" | "servers" | "dms";
let overlaySectionMode: OverlaySectionMode = "all";




function getOverlayBaseEntry(tab: OverlayTab, entry: any) {
    return tab === "edited" ? entry.after : entry;
}

function getStorage(): Storage | null {
    try {
        return typeof window !== "undefined" ? window.localStorage : null;
    } catch {
        return null;
    }
}

function getLiveKey(channelId: string, messageId: string) {
    return `${channelId}:${messageId}`;
}

function safeArray<T>(v: T[] | null | undefined): T[] {
    return Array.isArray(v) ? v : [];
}

function parseCsv(input: string | undefined): string[] {
    return (input ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

function nowIso() {
    return new Date().toISOString();
}

function escapeHtml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

function formatDate(iso?: string | null) {
    if (!iso) return "Unknown time";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function shortContent(text: string) {
    const flat = (text || "").replace(/\s+/g, " ").trim();
    if (!flat) return "<no text>";
    return flat.length > 110 ? `${flat.slice(0, 110)}…` : flat;
}

function getChannelName(channelId: string): string | null {
    try {
        return ChannelStore.getChannel(channelId)?.name ?? channelId;
    } catch {
        return channelId;
    }
}

function getGuildName(guildId?: string | null): string | null {
    if (!guildId) return null;
    try {
        const guildStore = (globalThis as any)?.Vencord?.webpack?.findByProps?.("getGuild");
        return guildStore?.getGuild?.(guildId)?.name ?? guildId;
    } catch {
        return guildId;
    }
}

function buildJumpHint(guildId: string | null, channelId: string, messageId?: string) {
    return guildId
        ? `/channels/${guildId}/${channelId}${messageId ? `/${messageId}` : ""}`
        : `/channels/@me/${channelId}${messageId ? `/${messageId}` : ""}`;
}

function normalizeMessage(raw: BasicMessage | null | undefined): OverlayMessage | null {
    if (!raw?.id || !raw?.channel_id) return null;

    const author = raw.author;
    const displayName = author?.globalName || author?.username || "Unknown User";
    const authorTag = author?.username ? `${displayName} (@${author.username})` : displayName;
    const channelId = String(raw.channel_id);
    const resolvedGuildId = raw.guild_id || ChannelStore.getChannel(channelId)?.guild_id || null;
    const guildId = resolvedGuildId ? String(resolvedGuildId) : null;
    const messageId = String(raw.id);

    return {
        id: messageId,
        channelId,
        guildId,
        channelName: getChannelName(channelId),
        guildName: getGuildName(guildId),
        content: raw.content || "",
        authorId: author?.id ? String(author.id) : null,
        authorTag,
        isBot: !!author?.bot,
        mentionEveryone: !!raw.mention_everyone,
        mentions: safeArray(raw.mentions).map(m => String(m.id || "")),
        timestamp: raw.timestamp || nowIso(),
        editedTimestamp: raw.edited_timestamp || null,
        attachments: safeArray(raw.attachments).map((a, i) => ({
            id: a.id || `${messageId}-att-${i}`,
            url: a.url || a.proxy_url || "",
            filename: a.filename || "attachment",
            contentType: a.content_type || "",
            deleted: !!a.deleted
        })),
        embeds: safeArray(raw.embeds).map((e: any) => ({
    type: e?.type || "",
    url: e?.url || "",
    title: e?.title || "",
    image: e?.image?.url ? { url: e.image.url } : undefined,
    thumbnail: e?.thumbnail?.url ? { url: e.thumbnail.url } : undefined,
    video: e?.video?.url ? { url: e.video.url } : undefined
})),
        jumpHint: buildJumpHint(guildId, channelId, messageId)
    };
}

function cloneRawMessage(raw: any): any {
    try {
        return JSON.parse(JSON.stringify(raw));
    } catch {
        return { ...raw };
    }
}

function hydrateDeletedRaw(raw: any): any {
    const cloned = cloneRawMessage(raw);
    cloned.deleted = true;
    cloned.state = cloned.state || "SENT";
    cloned.type = typeof cloned.type === "number" ? cloned.type : 0;
    cloned.__bmlSynthetic = true;
    if (Array.isArray(cloned.attachments)) {
        cloned.attachments = cloned.attachments.map((a: any) => ({ ...a, deleted: true }));
    }
    return cloned;
}

function trimEntries<T>(arr: T[]) {
    return arr.length > settings.store.savedLimit ? arr.slice(0, settings.store.savedLimit) : arr;
}

function readPersisted(): PersistedData {
    try {
        const storage = getStorage();
        if (!storage) return { deleted: [], edited: [], ghostPings: [] };
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return { deleted: [], edited: [], ghostPings: [] };
        const parsed = JSON.parse(raw);
        return {
            deleted: Array.isArray(parsed?.deleted) ? parsed.deleted : [],
            edited: Array.isArray(parsed?.edited) ? parsed.edited : [],
            ghostPings: Array.isArray(parsed?.ghostPings) ? parsed.ghostPings : []
        };
    } catch {
        return { deleted: [], edited: [], ghostPings: [] };
    }
}

const persisted: PersistedData = readPersisted();

function pruneOld() {
    const cutoff = Date.now() - settings.store.retentionDays * 24 * 60 * 60 * 1000;
    const keep = (iso: string) => {
        const t = new Date(iso).getTime();
        return Number.isFinite(t) && t >= cutoff;
    };

    persisted.deleted = persisted.deleted.filter(x => keep(x.deletedAt));
    persisted.edited = persisted.edited.filter(x => keep(x.editedAt));
    persisted.ghostPings = persisted.ghostPings.filter(x => keep(x.detectedAt));
}

function writePersisted() {
    const storage = getStorage();
    if (!storage) return;
    pruneOld();
    storage.setItem(STORAGE_KEY, JSON.stringify({
        deleted: trimEntries(persisted.deleted),
        edited: trimEntries(persisted.edited),
        ghostPings: trimEntries(persisted.ghostPings)
    }));
}

function downloadText(filename: string, text: string) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function shouldIgnore(message: any, isEdit = false) {
    try {
        const myId = UserStore.getCurrentUser()?.id;
        const ignoredUsers = parseCsv(settings.store.ignoreUsers);
        const ignoredChannels = parseCsv(settings.store.ignoreChannels);
        const ignoredGuilds = parseCsv(settings.store.ignoreGuilds);
        const channel = ChannelStore.getChannel(message.channel_id);

        return (settings.store.ignoreBots && message.author?.bot)
            || (settings.store.ignoreSelf && message.author?.id === myId)
            || ignoredUsers.includes(message.author?.id)
            || ignoredChannels.includes(message.channel_id)
            || ignoredChannels.includes(channel?.parent_id)
            || ignoredGuilds.includes(channel?.guild_id)
            || (isEdit ? !settings.store.logEdits : !settings.store.logDeletes);
    } catch {
        return false;
    }
}

function addDeleteStyle() {
    const id = "vc-bml-delete-style";
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
        el = document.createElement("style");
        el.id = id;
        document.head.appendChild(el);
    }

    el.textContent = settings.store.deleteStyle === "text"
        ? `.messagelogger-deleted{--text-default:var(--status-danger,#f04747);--interactive-icon-default:var(--status-danger,#f04747);--text-muted:var(--status-danger,#f04747);--embed-title:var(--red-460,#be3535);--text-link:var(--red-460,#be3535);--text-strong:var(--red-460,#be3535);}`
        : `.messagelogger-deleted{background-color:hsl(var(--red-430-hsl,0 85% 61%)/15%)!important;}`;
}

function removeDeleteStyle() {
    document.getElementById("vc-bml-delete-style")?.remove();
}

function getOverlayEntries(tab: OverlayTab) {
    const q = overlaySearch.trim().toLowerCase();

    if (tab === "deleted") {
        return persisted.deleted.filter(x =>
            !q
            || x.content.toLowerCase().includes(q)
            || x.authorTag.toLowerCase().includes(q)
            || (x.channelName || "").toLowerCase().includes(q)
            || (x.guildName || "").toLowerCase().includes(q)
        );
    }

    if (tab === "ghostPings") {
        return persisted.ghostPings.filter(x =>
            !q
            || x.content.toLowerCase().includes(q)
            || x.authorTag.toLowerCase().includes(q)
            || (x.channelName || "").toLowerCase().includes(q)
            || (x.guildName || "").toLowerCase().includes(q)
        );
    }

    return persisted.edited.filter(x =>
        !q
        || x.before.content.toLowerCase().includes(q)
        || x.after.content.toLowerCase().includes(q)
        || x.after.authorTag.toLowerCase().includes(q)
        || (x.after.channelName || "").toLowerCase().includes(q)
    );
}

function ensureOverlayRoot() {
    if (overlayRoot) return overlayRoot;
    overlayRoot = document.createElement("div");
    overlayRoot.id = "vc-bml-root";
    document.body.appendChild(overlayRoot);
    return overlayRoot;
}

function closeOverlay() {
    if (!overlayRoot) {
        overlayOpen = false;
        return;
    }

    overlayOpen = false;
    overlayRoot.classList.remove("vc-bml-open");
    overlayRoot.classList.add("vc-bml-closing");

    const rootToRemove = overlayRoot;
    overlayRoot = null;

    setTimeout(() => {
        rootToRemove.remove();
    }, 180);
}

function openOverlay() {
    overlayOpen = true;
    const root = ensureOverlayRoot();
    rerenderOverlay();

    root.classList.remove("vc-bml-closing");
    requestAnimationFrame(() => {
        root.classList.add("vc-bml-open");
    });
}

function toggleOverlay() {
    if (overlayOpen) closeOverlay();
    else openOverlay();
}

function renderMediaSection(msg: any) {
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    const embeds = Array.isArray(msg.embeds) ? msg.embeds : [];

    const attachmentHtml = attachments.map((a: any) => {
        const url = a.url || "";
        const filename = escapeHtml(a.filename || "attachment");
        const type = String(a.contentType || "").toLowerCase();

        if (!url) {
            return `<div class="vc-bml-mediaItem"><div class="vc-bml-mediaLabel">${filename}</div></div>`;
        }
        if (type.startsWith("image/")) {
            return `<div class="vc-bml-mediaItem"><div class="vc-bml-mediaLabel">${filename}</div><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer"><img class="vc-bml-mediaImage" src="${escapeHtml(url)}" alt="${filename}" loading="lazy" /></a></div>`;
        }
        if (type.startsWith("video/")) {
            return `<div class="vc-bml-mediaItem"><div class="vc-bml-mediaLabel">${filename}</div><video class="vc-bml-mediaVideo" src="${escapeHtml(url)}" controls preload="metadata"></video></div>`;
        }
        if (type.startsWith("audio/")) {
            return `<div class="vc-bml-mediaItem"><div class="vc-bml-mediaLabel">${filename}</div><audio class="vc-bml-mediaAudio" src="${escapeHtml(url)}" controls preload="metadata"></audio></div>`;
        }
        return `<div class="vc-bml-mediaItem"><div class="vc-bml-mediaLabel">${filename}</div><a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open attachment</a></div>`;
    }).join("");

    const embedHtml = embeds.map((e: any) => {
    const label = escapeHtml(e.title || e.type || "Embed");
    const mediaUrl = e.video?.url || e.image?.url || e.thumbnail?.url || "";
    const linkUrl = e.url || mediaUrl || "";
    const lower = mediaUrl.toLowerCase();

    if (mediaUrl) {
        if (e.type === "gifv" || lower.endsWith(".mp4") || lower.endsWith(".webm")) {
            return `<div class="vc-bml-mediaItem">
                <div class="vc-bml-mediaLabel">${label}</div>
                <video class="vc-bml-mediaVideo" src="${escapeHtml(mediaUrl)}" controls autoplay loop muted playsinline></video>
            </div>`;
        }

        if (/\.(gif|png|jpg|jpeg|webp)(\?|$)/i.test(lower)) {
            return `<div class="vc-bml-mediaItem">
                <div class="vc-bml-mediaLabel">${label}</div>
                <a href="${escapeHtml(linkUrl)}" target="_blank" rel="noreferrer">
                    <img class="vc-bml-mediaImage" src="${escapeHtml(mediaUrl)}" alt="${label}" loading="lazy" />
                </a>
            </div>`;
        }
    }

    return `<div class="vc-bml-mediaItem">
        <div class="vc-bml-mediaLabel">${label}</div>
        ${linkUrl ? `<a href="${escapeHtml(linkUrl)}" target="_blank" rel="noreferrer">Open embed</a>` : ""}
    </div>`;
}).join("");

    if (!attachmentHtml && !embedHtml) return "";

    return `<div class="vc-bml-section"><h3>Media</h3><div class="vc-bml-mediaGrid">${attachmentHtml}${embedHtml}</div></div>`;
}


function renderGroupedServerCards(tab: OverlayTab, items: Array<{ entry: any; index: number; }>) {
    const groups = new Map<string, Array<{ entry: any; index: number; }>>();

    for (const item of items) {
        const base = getOverlayBaseEntry(tab, item.entry);
        const key = base.guildName || base.guildId || "Unknown Server";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(item);
    }

    let html = "";
    for (const [guildName, groupItems] of groups) {
        html += `<div class="vc-bml-groupHeader">${escapeHtml(guildName)}</div>`;
        html += groupItems.map(item => renderOverlayCard(tab, item.entry, item.index)).join("");
    }

    return html;
}


function renderOverlayCard(tab: OverlayTab, entry: any, index: number) {
    const base = getOverlayBaseEntry(tab, entry);
    const preview = tab === "edited"
        ? `${entry.before.content} → ${entry.after.content}`
        : base.content;

    const time = tab === "deleted"
        ? entry.deletedAt
        : tab === "ghostPings"
            ? entry.detectedAt
            : entry.editedAt;

    return `<div class="vc-bml-card ${index === overlaySelectedIndex ? "active" : ""}" data-index="${index}">
        <div class="vc-bml-cardTop">
            <div>
                <div class="vc-bml-author">${escapeHtml(base.authorTag)}</div>
                <div class="vc-bml-loc">${escapeHtml(base.guildName || "DM")} · ${escapeHtml(base.channelName || base.channelId)}</div>
            </div>
            <div class="vc-bml-time">${escapeHtml(formatDate(time))}</div>
        </div>
        <div class="vc-bml-preview">${escapeHtml(shortContent(preview))}</div>
    </div>`;
}

function renderOverlayList(tab: OverlayTab, entries: any[]) {
    const indexed = entries.map((entry, index) => ({ entry, index }));

    const dms = indexed.filter(item => {
        const base = getOverlayBaseEntry(tab, item.entry);
        const channelGuildId = ChannelStore.getChannel(base.channelId)?.guild_id;
        return !(base.guildId || channelGuildId);
    });

    const servers = indexed.filter(item => {
        const base = getOverlayBaseEntry(tab, item.entry);
        const channelGuildId = ChannelStore.getChannel(base.channelId)?.guild_id;
        return !!(base.guildId || channelGuildId);
    });

    if (overlaySectionMode === "dms") {
        return dms.length
            ? `<div class="vc-bml-groupHeader">Direct Messages</div>${dms.map(item => renderOverlayCard(tab, item.entry, item.index)).join("")}`
            : `<div class="vc-bml-empty">No DM entries found.</div>`;
    }

    if (overlaySectionMode === "servers") {
        return servers.length
            ? `<div class="vc-bml-groupHeader">Servers</div>${servers.map(item => renderOverlayCard(tab, item.entry, item.index)).join("")}`
            : `<div class="vc-bml-empty">No server entries found.</div>`;
    }

    let html = "";

    if (dms.length) {
        html += `<div class="vc-bml-groupHeader">Direct Messages</div>`;
        html += dms.map(item => renderOverlayCard(tab, item.entry, item.index)).join("");
    }

    if (servers.length) {
        html += `<div class="vc-bml-groupHeader">Servers</div>`;
        html += servers.map(item => renderOverlayCard(tab, item.entry, item.index)).join("");
    }

    return html || `<div class="vc-bml-empty">No entries found.</div>`;
}

function renderOverlayDetail(tab: OverlayTab, entry: any) {
    if (!entry) {
        return `<div class="vc-bml-empty"><div><div style="font-size:18px;font-weight:800;margin-bottom:8px">Nothing selected</div><div>Select a log entry on the left.</div></div></div>`;
    }

    if (tab === "edited") {
        return `
            <div class="vc-bml-section">
                <h3>Overview</h3>
                <div class="vc-bml-grid">
                    <div class="vc-bml-info"><div class="vc-bml-infoLabel">Author</div><div class="vc-bml-infoValue">${escapeHtml(entry.after.authorTag)}</div></div>
                    <div class="vc-bml-info"><div class="vc-bml-infoLabel">Guild</div><div class="vc-bml-infoValue">${escapeHtml(entry.after.guildName || "DM")}</div></div>
                    <div class="vc-bml-info"><div class="vc-bml-infoLabel">Channel</div><div class="vc-bml-infoValue">${escapeHtml(entry.after.channelName || entry.after.channelId)}</div></div>
                    <div class="vc-bml-info"><div class="vc-bml-infoLabel">Edited At</div><div class="vc-bml-infoValue">${escapeHtml(formatDate(entry.editedAt))}</div></div>
                </div>
            </div>
            <div class="vc-bml-section">
                <h3>Before</h3>
                <div class="vc-bml-message">${escapeHtml(entry.before.content || "<no text>")}</div>
            </div>
            <div class="vc-bml-section">
                <h3>After</h3>
                <div class="vc-bml-message">${escapeHtml(entry.after.content || "<no text>")}</div>
            </div>
            ${renderMediaSection(entry.after)}
            <div class="vc-bml-section">
                <button class="vc-bml-btn primary" data-action="jump" data-route="${escapeHtml(entry.after.jumpHint)}">Jump to chat</button>
            </div>`;
    }

    const time = tab === "deleted" ? entry.deletedAt : entry.detectedAt;

    return `
        <div class="vc-bml-section">
            <h3>Overview</h3>
            <div class="vc-bml-grid">
                <div class="vc-bml-info"><div class="vc-bml-infoLabel">Author</div><div class="vc-bml-infoValue">${escapeHtml(entry.authorTag)}</div></div>
                <div class="vc-bml-info"><div class="vc-bml-infoLabel">Guild</div><div class="vc-bml-infoValue">${escapeHtml(entry.guildName || "DM")}</div></div>
                <div class="vc-bml-info"><div class="vc-bml-infoLabel">Channel</div><div class="vc-bml-infoValue">${escapeHtml(entry.channelName || entry.channelId)}</div></div>
                <div class="vc-bml-info"><div class="vc-bml-infoLabel">Time</div><div class="vc-bml-infoValue">${escapeHtml(formatDate(time))}</div></div>
            </div>
        </div>
        <div class="vc-bml-section">
            <h3>Message</h3>
            <div class="vc-bml-message">${escapeHtml(entry.content || "<no text>")}</div>
        </div>
        ${renderMediaSection(entry)}
        <div class="vc-bml-section">
            <button class="vc-bml-btn primary" data-action="jump" data-route="${escapeHtml(entry.jumpHint)}">Jump to chat</button>
        </div>`;
}

function navigateTo(route: string) {
    try {
        const router =
            (globalThis as any)?.Vencord?.webpack?.findByProps?.("transitionTo", "replaceWith") ||
            (globalThis as any)?.Vencord?.webpack?.findByProps?.("transitionTo");

        if (router?.transitionTo) {
            closeOverlay();
            setTimeout(() => router.transitionTo(route), 0);
            return;
        }
    } catch (err) {
        console.error("BestMessageLogger router transition failed:", err);
    }

    try {
        closeOverlay();

        const url = new URL(route, window.location.origin);
        window.history.pushState({}, "", url.pathname + url.search + url.hash);
        window.dispatchEvent(new PopStateEvent("popstate"));
        return;
    } catch (err) {
        console.error("BestMessageLogger history navigation failed:", err);
    }

    try {
        closeOverlay();
        window.location.assign(route);
    } catch (err) {
        console.error("BestMessageLogger final navigation fallback failed:", err);
    }
}

function getOverlayEntryKey(tab: OverlayTab, entry: any) {
    if (tab === "edited") {
        return `e:${entry.messageId}:${entry.historyIndex}:${entry.editedAt}`;
    }

    if (tab === "ghostPings") {
        return `g:${entry.id}:${entry.reason}:${entry.detectedAt}`;
    }

    return `d:${entry.id}:${entry.deletedAt}`;
}

function rerenderOverlay() {
    if (!overlayOpen) return;

    const root = ensureOverlayRoot();
    const prevList = root.querySelector(".vc-bml-list") as HTMLDivElement | null;
    const prevDetail = root.querySelector(".vc-bml-detail") as HTMLDivElement | null;
    const prevSearch = root.querySelector("#vc-bml-search") as HTMLInputElement | null;

    const savedListScroll = prevList?.scrollTop ?? 0;
    const savedDetailScroll = prevDetail?.scrollTop ?? 0;
    const hadSearchFocus = document.activeElement === prevSearch;
    const savedSelStart = prevSearch?.selectionStart ?? overlaySearch.length;
    const savedSelEnd = prevSearch?.selectionEnd ?? overlaySearch.length;

    const entries = getOverlayEntries(overlayTab);

if (overlaySelectedKey) {
    const foundIndex = entries.findIndex(entry => getOverlayEntryKey(overlayTab, entry) === overlaySelectedKey);
    if (foundIndex !== -1) {
        overlaySelectedIndex = foundIndex;
    } else if (overlaySelectedIndex >= entries.length) {
        overlaySelectedIndex = Math.max(0, entries.length - 1);
    }
} else if (overlaySelectedIndex >= entries.length) {
    overlaySelectedIndex = Math.max(0, entries.length - 1);
}

const selected = entries[overlaySelectedIndex] ?? null;
overlaySelectedKey = selected ? getOverlayEntryKey(overlayTab, selected) : null;

    root.innerHTML = `
        <div class="vc-bml-backdrop" data-close="1"></div>
        <div class="vc-bml-window">
            <div class="vc-bml-header">
                <div class="vc-bml-titleWrap">
                    <div class="vc-bml-title">BestMessageLogger</div>
                    <div class="vc-bml-sub">Deleted messages, edits, ghost pings, export, and search.</div>
                </div>
                <div class="vc-bml-actions">
                    <button class="vc-bml-btn primary" data-action="export">Export JSON</button>
                    <button class="vc-bml-btn danger" data-action="clear">Clear Tab</button>
                    <button class="vc-bml-btn" data-close="1">Close</button>
                </div>
            </div>

            <div class="vc-bml-toolbar">
                <div class="vc-bml-toolbarMain">
                    <div class="vc-bml-tabs">
                        <button class="vc-bml-tab ${overlayTab === "deleted" ? "active" : ""}" data-tab="deleted">Deleted · ${persisted.deleted.length}</button>
                        <button class="vc-bml-tab ${overlayTab === "edited" ? "active" : ""}" data-tab="edited">Edits · ${persisted.edited.length}</button>
                        <button class="vc-bml-tab ${overlayTab === "ghostPings" ? "active" : ""}" data-tab="ghostPings">Ghost Pings · ${persisted.ghostPings.length}</button>
                    </div>
                    <input id="vc-bml-search" class="vc-bml-search" value="${escapeHtml(overlaySearch)}" placeholder="Search content, author, channel, or guild..." />
                    <div class="vc-bml-meta">Hotkey ${escapeHtml(settings.store.openHotkey)}</div>
                </div>

                <div class="vc-bml-organizer">
                    <button class="vc-bml-filterBtn ${overlaySectionMode === "all" ? "active" : ""}" data-section="all">All</button>
                    <button class="vc-bml-filterBtn ${overlaySectionMode === "servers" ? "active" : ""}" data-section="servers">Servers</button>
                    <button class="vc-bml-filterBtn ${overlaySectionMode === "dms" ? "active" : ""}" data-section="dms">DMs</button>
                </div>
            </div>

            <div class="vc-bml-body">
                <div class="vc-bml-list">
                    ${renderOverlayList(overlayTab, entries)}
                </div>
                <div class="vc-bml-detail">
                    ${renderOverlayDetail(overlayTab, selected)}
                </div>
            </div>

            <div class="vc-bml-footerBrand">
                ${BRAND_AVATAR_URL ? `<img src="${escapeHtml(BRAND_AVATAR_URL)}" alt="${escapeHtml(BRAND_NAME)}" />` : ""}
                <span>Made By ${escapeHtml(BRAND_NAME)}</span>
                <a href="${escapeHtml(BRAND_LINK)}" target="_blank" rel="noreferrer">Guns.lol</a>
            </div>
        </div>
    `;

    root.onclick = e => {
        const target = e.target as HTMLElement | null;
        if (!target) return;

        if (target.closest("[data-close='1']")) {
            closeOverlay();
            return;
        }

        const tab = target.closest("[data-tab]")?.getAttribute("data-tab") as OverlayTab | null;
        if (tab) {
            overlayTab = tab;
            overlaySelectedIndex = 0;
            overlaySelectedKey = null;
            ignoreNextSearchFocusRestore = false;
            rerenderOverlay();
            return;
        }

        const section = target.closest("[data-section]")?.getAttribute("data-section") as OverlaySectionMode | null;
        if (section) {
            overlaySectionMode = section;
            overlaySelectedIndex = 0;
            ignoreNextSearchFocusRestore = false;
            rerenderOverlay();
            return;
        }

        const idx = target.closest("[data-index]")?.getAttribute("data-index");
        if (idx != null) {
            overlaySelectedIndex = Number(idx);
            const clickedEntry = entries[overlaySelectedIndex];
            overlaySelectedKey = clickedEntry ? getOverlayEntryKey(overlayTab, clickedEntry) : null;
            ignoreNextSearchFocusRestore = true;
            rerenderOverlay();
            return;
        }

        const action = target.closest("[data-action]")?.getAttribute("data-action");
        if (action === "export") {
            downloadText(`BestMessageLogger-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, exportJson());
            showToast("BestMessageLogger export downloaded.", Toasts.Type.SUCCESS);
            return;
        }

        if (action === "clear") {
            if (overlayTab === "deleted") persisted.deleted = [];
            else if (overlayTab === "edited") persisted.edited = [];
            else persisted.ghostPings = [];
            writePersisted();
            overlaySelectedIndex = 0;
            rerenderOverlay();
            return;
        }

        if (action === "jump") {
            const route = target.closest("[data-route]")?.getAttribute("data-route");
            if (route) navigateTo(route);
            return;
        }
    };

    const list = root.querySelector(".vc-bml-list") as HTMLDivElement | null;
    const detail = root.querySelector(".vc-bml-detail") as HTMLDivElement | null;
    if (list) list.scrollTop = savedListScroll;
    if (detail) detail.scrollTop = ignoreNextSearchFocusRestore ? 0 : savedDetailScroll;

    const search = root.querySelector<HTMLInputElement>("#vc-bml-search");
    if (search) {
        search.oninput = () => {
            overlaySearch = search.value;
            overlaySelectedIndex = 0;
            overlaySelectedKey = null;
            ignoreNextSearchFocusRestore = false;
            rerenderOverlay();
        };

        search.onkeydown = e => e.stopPropagation();

        if (hadSearchFocus && !ignoreNextSearchFocusRestore) {
            search.focus();
            search.setSelectionRange(savedSelStart, savedSelEnd);
        }
    }

    ignoreNextSearchFocusRestore = false;
}

function exportJson() {
    return JSON.stringify({ version: VERSION, exportedAt: nowIso(), data: persisted }, null, 2);
}

function parseHotkey(hotkey: string) {
    const parts = hotkey.toLowerCase().split("+").map(x => x.trim()).filter(Boolean);
    return {
        ctrl: parts.includes("ctrl") || parts.includes("control"),
        shift: parts.includes("shift"),
        alt: parts.includes("alt"),
        key: parts.find(x => !["ctrl", "control", "shift", "alt"].includes(x)) || "i"
    };
}

function setupHotkey() {
    teardownHotkey();
    hotkeyHandler = e => {
        const hk = parseHotkey(settings.store.openHotkey || "Ctrl+Shift+I");
        if (!!e.ctrlKey !== hk.ctrl) return;
        if (!!e.shiftKey !== hk.shift) return;
        if (!!e.altKey !== hk.alt) return;
        if (e.key.toLowerCase() !== hk.key) return;
        e.preventDefault();
        toggleOverlay();
    };
    window.addEventListener("keydown", hotkeyHandler, true);
}

function teardownHotkey() {
    if (hotkeyHandler) window.removeEventListener("keydown", hotkeyHandler, true);
    hotkeyHandler = null;
}

function exposeApi() {
    (window as any).BestMessageLogger = {
        version: VERSION,
        open: openOverlay,
        close: closeOverlay,
        toggle: toggleOverlay,
        dump: () => persisted,
        exportJson,
        downloadJson: () => downloadText(`BestMessageLogger-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, exportJson()),
        clearAll: () => {
            persisted.deleted = [];
            persisted.edited = [];
            persisted.ghostPings = [];
            writePersisted();
            if (overlayOpen) rerenderOverlay();
        }
    } satisfies PluginApi;
}

function unexposeApi() {
    try {
        delete (window as any).BestMessageLogger;
    } catch {}
}

function saveDelete(entry: DeleteEntry) {
    persisted.deleted.unshift(entry);
    persisted.deleted = trimEntries(persisted.deleted);
    writePersisted();
    if (overlayOpen) rerenderOverlay();
}

function saveEdit(entry: EditEntry) {
    persisted.edited.unshift(entry);
    persisted.edited = trimEntries(persisted.edited);
    writePersisted();
    if (overlayOpen) rerenderOverlay();
}

function saveGhost(entry: GhostPingEntry) {
    const key = `${entry.id}:${entry.reason}`;
    if (GHOST_DEDUPE.has(key)) return;
    GHOST_DEDUPE.add(key);
    persisted.ghostPings.unshift(entry);
    persisted.ghostPings = trimEntries(persisted.ghostPings);
    writePersisted();
    if (overlayOpen) rerenderOverlay();
}

function parseEditContent(content: string, message: any) {
    return Parser.parse(content, true, {
        channelId: message.channel_id,
        messageId: message.id,
        allowLinks: true,
        allowHeading: true,
        allowList: true,
        allowEmojiLinks: true,
        viewingChannelId: SelectedChannelStore.getChannelId(),
    });
}

export function openHistoryModal(message: any) {
    openModal(props => (
        <ErrorBoundary>
            <HistoryModal modalProps={props} message={message} />
        </ErrorBoundary>
    ));
}

function HistoryModal({ modalProps, message }: { modalProps: ModalProps; message: any; }) {
    const [currentTab, setCurrentTab] = useState(message.editHistory.length);
    const timestamps = [message.firstEditTimestamp, ...message.editHistory.map((m: any) => m.timestamp)];
    const contents = [...message.editHistory.map((m: any) => m.content), message.content];

    return (
        <ModalRoot {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader className={modalCl("head")}>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>Message Edit History</Text>
                <ModalCloseButton onClick={modalProps.onClose} />
            </ModalHeader>
            <ModalContent className={modalCl("contents")}>
                <TabBar
                    type="top"
                    look="brand"
                    className={classes("vc-settings-tab-bar", modalCl("tab-bar"))}
                    selectedItem={currentTab}
                    onItemSelect={setCurrentTab}
                >
                    {message.firstEditTimestamp?.getTime?.() !== message.timestamp?.getTime?.() && (
                        <TooltipContainer text="This edit state was not logged so it can't be displayed.">
                            <TabBar.Item className="vc-settings-tab-bar-item" id={-1} disabled>
                                <Timestamp className={modalCl("timestamp")} timestamp={message.timestamp} isEdited={true} isInline={false} />
                            </TabBar.Item>
                        </TooltipContainer>
                    )}
                    {timestamps.map((timestamp: Date, index: number) => (
                        <TabBar.Item key={index} className="vc-settings-tab-bar-item" id={index}>
                            <Timestamp className={modalCl("timestamp")} timestamp={timestamp} isEdited={true} isInline={false} />
                        </TabBar.Item>
                    ))}
                </TabBar>
                <div className={classes(CodeContainerClasses.markup, MiscClasses.messageContent)}>
                    {parseEditContent(contents[currentTab], message)}
                </div>
            </ModalContent>
        </ModalRoot>
    );
}

function renderEdits({ message: { id: messageId, channel_id: channelId } }: { message: any; }) {
    const message = useStateFromStores(
        [MessageStore],
        () => MessageStore.getMessage(channelId, messageId) as any,
        null,
        (oldMsg, newMsg) => oldMsg?.editHistory === newMsg?.editHistory
    );

    return settings.store.inlineEdits && (
        <>
            {message?.editHistory?.map((edit: any, idx: number) => (
                <div key={idx} className="messagelogger-edited">
                    {parseEditContent(edit.content, message)}
                    <Timestamp timestamp={edit.timestamp} isEdited={true} isInline={false}>
                        <span className={MessageClasses.edited}> {" "}(edited)</span>
                    </Timestamp>
                </div>
            ))}
        </>
    );
}

function EditMarker({ message, className, children, ...props }: any) {
    return (
        <span
            {...props}
            className={classes("messagelogger-edit-marker", className)}
            onClick={() => openHistoryModal(message)}
            role="button"
        >
            {children}
        </span>
    );
}

function archiveRawDeletedMessage(msg: any) {
    const hydrated = hydrateDeletedRaw(msg);
    DELETED_ARCHIVE.set(getLiveKey(String(hydrated.channel_id), String(hydrated.id)), hydrated);
}

function collectOverlayDelete(msg: any, kind: "delete" | "bulk-delete") {
    const normalized = normalizeMessage(msg);
    if (!normalized) return;
    OVERLAY_CACHE.set(normalized.id, normalized);
    saveDelete({ ...normalized, deletedAt: nowIso(), kind });
    if (settings.store.logGhostPings) {
        const myId = UserStore.getCurrentUser()?.id;
        const pinged = normalized.mentionEveryone || normalized.mentions.includes(myId);
        if (pinged) {
            saveGhost({ ...normalized, detectedAt: nowIso(), reason: "deleted" });
        }
    }
}

function collectOverlayEdit(oldMessage: any, newMessage: any) {
    const before = normalizeMessage(oldMessage);
    const after = normalizeMessage(newMessage);
    if (!before || !after) return;
    const hist = EDIT_CACHE.get(after.id) ?? [];
    hist.push(before);
    EDIT_CACHE.set(after.id, hist);
    saveEdit({
        messageId: after.id,
        channelId: after.channelId,
        guildId: after.guildId,
        before,
        after,
        editedAt: nowIso(),
        historyIndex: hist.length
    });
    if (settings.store.logGhostPings) {
        const myId = UserStore.getCurrentUser()?.id;
        const hadPing = before.mentionEveryone || before.mentions.includes(myId);
        const hasPing = after.mentionEveryone || after.mentions.includes(myId);
        if (hadPing && !hasPing) {
            saveGhost({ ...before, detectedAt: nowIso(), reason: "edited" });
        }
    }
}

function queueOverlayDelete(msg: any, kind: "delete" | "bulk-delete") {
    setTimeout(() => {
        try {
            collectOverlayDelete(msg, kind);
        } catch (err) {
            console.error("BestMessageLogger overlay delete queue failed:", err);
        }
    }, 0);
}

function onMessageCreate(event: { message?: any; optimistic?: boolean; }) {
    const msg = event?.message;
    if (!msg?.id || !msg?.channel_id || msg.__bmlSynthetic) return;
    LIVE_MESSAGE_CACHE.set(getLiveKey(String(msg.channel_id), String(msg.id)), cloneRawMessage(msg));
}

function onMessageUpdateEvent(event: { message?: any; }) {
    const msg = event?.message;
    if (!msg?.id || !msg?.channel_id || msg.__bmlSynthetic) return;
    const key = getLiveKey(String(msg.channel_id), String(msg.id));
    const prev = LIVE_MESSAGE_CACHE.get(key);
    LIVE_MESSAGE_CACHE.set(key, { ...(prev ?? {}), ...cloneRawMessage(msg) });
}

function rehydrateDeletedForChannel(channelId?: string | null) {
    if (!channelId) return;
    const existing = MessageStore.getMessages(channelId) as any[] | undefined;
    const existingIds = new Set<string>((existing ?? []).map((m: any) => String(m.id)));

    for (const [key, msg] of DELETED_ARCHIVE.entries()) {
        if (String(msg.channel_id) !== String(channelId)) continue;
        if (existingIds.has(String(msg.id))) continue;

        FluxDispatcher.dispatch({
            type: "MESSAGE_CREATE",
            message: hydrateDeletedRaw(msg),
            optimistic: false
        } as any);
    }
}

function onChannelSelect(event: any) {
    const channelId = event?.channelId || event?.channel_id || event?.channel?.id;
    if (!channelId) return;
    setTimeout(() => rehydrateDeletedForChannel(String(channelId)), 0);
}

function onLoadMessages(event: any) {
    const channelId = event?.channelId || event?.channel_id || event?.channel?.id;
    if (!channelId) return;
    setTimeout(() => rehydrateDeletedForChannel(String(channelId)), 0);
}

function makeEdit(newMessage: any, oldMessage: any) {
    return {
        timestamp: new Date(newMessage.edited_timestamp),
        content: oldMessage.content
    };
}

function handleDelete(cache: any, data: { ids: string[]; id: string; mlDeleted?: boolean; channelId?: string; }, isBulk: boolean) {
    try {
        if (!cache || typeof cache.get !== "function" || typeof cache.update !== "function") {
            return cache;
        }

        const mutate = (id: string) => {
            let msg = cache.get(id);
            if (!msg) {
                const live = LIVE_MESSAGE_CACHE.get(getLiveKey(String(data.channelId || ""), String(id)));
                if (live) msg = live;
                else return;
            }

            const key = getLiveKey(String(msg.channel_id || data.channelId || ""), String(id));

            if (data.mlDeleted) {
                DELETED_ARCHIVE.delete(key);
                LIVE_MESSAGE_CACHE.delete(key);
                if (typeof cache.remove === "function" && cache.get(id)) {
                    cache = cache.remove(id);
                }
                return;
            }

            const EPHEMERAL = 64;
            const shouldSkip = (msg.flags & EPHEMERAL) === EPHEMERAL || shouldIgnore(msg);
            if (shouldSkip) return;

            archiveRawDeletedMessage(msg);
            queueOverlayDelete(msg, isBulk ? "bulk-delete" : "delete");

            if (cache.get(id)) {
                cache = cache.update(id, (m: any) => {
                    if (!m || typeof m.set !== "function") return m;
                    try {
                        const next = m.set("deleted", true);
                        if (typeof next.set === "function" && next.attachments?.map) {
                            return next.set("attachments", next.attachments.map((a: any) => (a.deleted = true, a)));
                        }
                        return next;
                    } catch (err) {
                        console.error("BestMessageLogger: failed to mark message as deleted", err);
                        return m;
                    }
                });
            }

            LIVE_MESSAGE_CACHE.delete(key);
        };

        if (isBulk) {
            for (const id of data.ids ?? []) mutate(id);
        } else if (data.id) {
            mutate(data.id);
        }
    } catch (err) {
        console.error("BestMessageLogger handleDelete crash prevented:", err);
    }

    return cache;
}

function DeletedMessageCount() {
    return {
        ast: [[6, "count", { "=0": ["No deleted messages"], one: [[1, "count"], " deleted message"], other: [[1, "count"], " deleted messages"] }, 0, "cardinal"]]
    };
}

const patchMessageContextMenu: NavContextMenuPatchCallback = (children, props) => {
    const { message } = props;
    const { deleted, editHistory, id, channel_id } = message as any;
    if (!deleted && !editHistory?.length) return;

    if (deleted) {
        const domElement = document.getElementById(`chat-messages-${channel_id}-${id}`);
        if (domElement) {
            children.push(
                <Menu.MenuItem
                    id="bml-toggle-style"
                    key="bml-toggle-style"
                    label="Toggle Deleted Highlight"
                    action={() => domElement.classList.toggle("messagelogger-deleted")}
                />
            );
        }
    }

    children.push(
        <Menu.MenuItem
            id="bml-remove-history"
            key="bml-remove-history"
            label="Remove Message History"
            color="danger"
            action={() => {
                if (deleted) {
                    FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", channelId: channel_id, id, mlDeleted: true } as any);
                } else {
                    (message as any).editHistory = [];
                }
            }}
        />
    );
};

const patchChannelContextMenu: NavContextMenuPatchCallback = (children, { channel }) => {
    const messages = MessageStore.getMessages(channel?.id) as any[];
    if (!messages?.some(msg => msg.deleted || msg.editHistory?.length)) return;
    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;
    group.push(
        <Menu.MenuItem
            id="vc-bml-clear-channel"
            label="Clear Message Log"
            color="danger"
            action={() => {
                messages.forEach(msg => {
                    if (msg.deleted) FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", channelId: channel.id, id: msg.id, mlDeleted: true } as any);
                    else updateMessage(channel.id, msg.id, { editHistory: [] });
                });
            }}
        />
    );
};

export default definePlugin({
    name: PLUGIN_NAME,
    description: "Logs deleted and edited messages, keeps deleted messages visible in chat, and provides a glassy searchable log menu.",
    authors,
    settings,
    dependencies: ["MessageUpdaterAPI"],

    contextMenus: {
        message: patchMessageContextMenu,
        "channel-context": patchChannelContextMenu,
        "thread-context": patchChannelContextMenu,
        "user-context": patchChannelContextMenu,
        "gdm-context": patchChannelContextMenu
    },

    start() {
        addDeleteStyle();
        setupHotkey();
        exposeApi();
        pruneOld();
        writePersisted();
        FluxDispatcher.subscribe("MESSAGE_CREATE" as never, onMessageCreate as never);
        FluxDispatcher.subscribe("MESSAGE_UPDATE" as never, onMessageUpdateEvent as never);
        FluxDispatcher.subscribe("CHANNEL_SELECT" as never, onChannelSelect as never);
        FluxDispatcher.subscribe("LOAD_MESSAGES_SUCCESS" as never, onLoadMessages as never);
        showToast("BestMessageLogger started.", Toasts.Type.MESSAGE);
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE" as never, onMessageCreate as never);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE" as never, onMessageUpdateEvent as never);
        FluxDispatcher.unsubscribe("CHANNEL_SELECT" as never, onChannelSelect as never);
        FluxDispatcher.unsubscribe("LOAD_MESSAGES_SUCCESS" as never, onLoadMessages as never);
        teardownHotkey();
        closeOverlay();
        removeDeleteStyle();
        unexposeApi();
    },

    renderEdits: ErrorBoundary.wrap(renderEdits, { noop: true }),
    handleDelete,
    makeEdit,
    shouldIgnore,
    EditMarker,
    DELETED_MESSAGE_COUNT: DeletedMessageCount,

    patches: [
        {
            find: '"MessageStore"',
            replacement: [
                {
                    match: /function (?=.+?MESSAGE_DELETE:(\i))\1\((\i)\){let.+?((?:\i\.){2})getOrCreate.+?}(?=function)/,
                    replace:
                        "function $1($2){" +
                        "var cache=$3getOrCreate($2.channelId);" +
                        "cache=$self.handleDelete(cache,$2,false);" +
                        "$3commit(cache);" +
                        "}"
                },
                {
                    match: /function (?=.+?MESSAGE_DELETE_BULK:(\i))\1\((\i)\){let.+?((?:\i\.){2})getOrCreate.+?}(?=function)/,
                    replace:
                        "function $1($2){" +
                        "var cache=$3getOrCreate($2.channelId);" +
                        "cache=$self.handleDelete(cache,$2,true);" +
                        "$3commit(cache);" +
                        "}"
                },
                {
                    match: /(function (\i)\((\i)\).+?)\.update\((\i)(?=.*MESSAGE_UPDATE:\2)/,
                    replace:
                        "$1" +
                        ".update($4,m => ((($3.message.flags & 64) === 64) || $self.shouldIgnore($3.message, true)) ? m : ($3.message.edited_timestamp && $3.message.content !== m.content ? m.set('editHistory',[...(m.editHistory || []), $self.makeEdit($3.message, m)]) : m))" +
                        ".update($4"
                },
                {
                    match: /(?<=getLastEditableMessage\(\i\)\{.{0,200}\.find\((\i)=>)/,
                    replace: "!$1.deleted&&"
                }
            ]
        },
        {
            find: "}addReaction(",
            replacement: [
                {
                    match: /this\.customRenderedContent=(\i)\.customRenderedContent,/,
                    replace:
                        "this.customRenderedContent=$1.customRenderedContent," +
                        "this.deleted=$1.deleted||false," +
                        "this.editHistory=$1.editHistory||[]," +
                        "this.firstEditTimestamp=$1.firstEditTimestamp||this.editedTimestamp||this.timestamp,"
                }
            ]
        },
        {
            find: ".PREMIUM_REFERRAL&&(",
            replacement: [
                {
                    match: /(?<=null!=\i\.edited_timestamp\)return )\i\(\i,\{reactions:(\i)\.reactions.{0,50}\}\)/,
                    replace: "Object.assign($&,{deleted:$1.deleted,editHistory:$1.editHistory,firstEditTimestamp:$1.firstEditTimestamp})"
                },
                {
                    match: /attachments:(\i)\((\i)\)/,
                    replace:
                        "attachments:$1((()=>{" +
                        "if($self.shouldIgnore($2))return $2;" +
                        "let old=arguments[1]?.attachments;" +
                        "if(!old)return $2;" +
                        "let nextIds=$2.attachments?.map(a=>a.id)??[];" +
                        "let diff=old.filter(a=>!nextIds.includes(a.id));" +
                        "old.forEach(a=>a.deleted=true);" +
                        "$2.attachments=[...diff,...$2.attachments];" +
                        "return $2;" +
                        "})())," +
                        "deleted:arguments[1]?.deleted," +
                        "editHistory:arguments[1]?.editHistory," +
                        "firstEditTimestamp:new Date(arguments[1]?.firstEditTimestamp??$2.editedTimestamp??$2.timestamp)"
                },
                {
                    match: /(\((\i)\){return null==\2\.attachments.+?)spoiler:/,
                    replace: "$1deleted:arguments[0]?.deleted,spoiler:"
                }
            ]
        },
        {
            find: "#{intl::REMOVE_ATTACHMENT_TOOLTIP_TEXT}",
            replacement: {
                match: /\.SPOILER,(?=\[\i\.\i\]:)/,
                replace: '$&"messagelogger-deleted-attachment":arguments[0]?.item?.originalItem?.deleted,'
            }
        },
        {
    find: "Message must not be a thread starter message",
    replacement: [
        {
            match: /\)\("li",\{(.+?),className:/,
            replace: ")(\"li\",{$1,className:(arguments[0].message.deleted ? \"messagelogger-deleted \" : \"\")+"
        }
    ]
},
        {
            find: ".SEND_FAILED,",
            replacement: {
                match: /\]:\i.isUnsupported.{0,20}?,children:\[/,
                replace: "$&arguments[0]?.message?.editHistory?.length>0&&$self.renderEdits(arguments[0]),"
            }
        },
        {
            find: "#{intl::MESSAGE_EDITED}",
            replacement: {
                match: /(isInline:!1,children:.{0,50}?)"span",\{(?=className:)/,
                replace: "$1$self.EditMarker,{message:arguments[0].message,"
            }
        },
        {
            find: '"ReferencedMessageStore"',
            replacement: [
                { match: /MESSAGE_DELETE:\i,/, replace: "MESSAGE_DELETE:()=>{}," },
                { match: /MESSAGE_DELETE_BULK:\i,/, replace: "MESSAGE_DELETE_BULK:()=>{}," }
            ]
        },
        {
            find: ".MESSAGE,commandTargetId:",
            replacement: {
                match: /children:(\[""===.+?\])/, replace: "children:arguments[0].message.deleted?[]:$1"
            }
        },
        {
            find: "NON_COLLAPSIBLE.has(",
            replacement: {
                match: /if\((\i)\.blocked\)return \i\.\i\.MESSAGE_GROUP_BLOCKED;/,
                replace: '$&else if($1.deleted)return"MESSAGE_GROUP_DELETED";'
            },
            predicate: () => settings.store.collapseDeleted
        },
        {
            find: "#{intl::NEW_MESSAGES_ESTIMATED_WITH_DATE}",
            replacement: [
                { match: /(\i).type===\i\.\i\.MESSAGE_GROUP_BLOCKED\|\|/, replace: '$&$1.type==="MESSAGE_GROUP_DELETED"||' },
                { match: /(\i).type===\i\.\i\.MESSAGE_GROUP_BLOCKED\?.*?:/, replace: '$&$1.type==="MESSAGE_GROUP_DELETED"?$self.DELETED_MESSAGE_COUNT:' }
            ],
            predicate: () => settings.store.collapseDeleted
        }
    ]
});
