const formFields = {
  name: document.getElementById("name"),
  email: document.getElementById("email"),
  dob: document.getElementById("dob")
};
const uploadedImagePreview = document.getElementById("uploadedImagePreview");
const uploadedImageHint = document.getElementById("uploadedImageHint");
const ocrNameField = document.getElementById("ocrName");
const ocrPassportIdField = document.getElementById("ocrPassportId");

let syncTimer = null;
let watermark = null;
let lastRenderedImageActivityId = null;
const druidRuntime = {
  chatBearerToken: null,
  directLineToken: null,
  gptBearerToken: null,
  conversationId: null,
  getStatusUrl: null
};
let consecutiveFailures = 0;

installNetworkTokenCapture();

document.addEventListener("DOMContentLoaded", () => {
  runAutoFillSync();
});

async function runAutoFillSync() {
  if (shouldStopAutofillSync()) {
    clearTimeout(syncTimer);
    syncTimer = null;
    return;
  }

  try {
    const response = await fetch("/api/autofill-from-druid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        watermark,
        currentForm: getCurrentFormState(),
        chatBearerToken: druidRuntime.chatBearerToken,
        directLineToken: druidRuntime.directLineToken,
        gptBearerToken: druidRuntime.gptBearerToken,
        conversationId: druidRuntime.conversationId,
        getStatusUrl: druidRuntime.getStatusUrl
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      const details = payload?.details ? ` Details: ${payload.details}` : "";
      throw new Error(`${payload?.error || "Autofill sync failed."}${details}`);
    }

    consecutiveFailures = 0;
    watermark = payload?.watermark || watermark;
    const updates = payload?.updates || [];
    for (const update of updates) {
      applyExtractedFields(update.extracted || {});
    }
    applyUploadedImages(payload?.uploadedImages || []);
    applyImageExtraction(payload?.imageExtraction || null);
  } catch (err) {
    consecutiveFailures += 1;
    console.error("Autofill sync error:", err.message);
  } finally {
    if (shouldStopAutofillSync()) {
      clearTimeout(syncTimer);
      syncTimer = null;
      return;
    }
    clearTimeout(syncTimer);
    const delay = consecutiveFailures > 3 ? 4500 : 1800;
    syncTimer = setTimeout(runAutoFillSync, delay);
  }
}

function shouldStopAutofillSync() {
  return Boolean(getCheckedValue("creditCard"));
}

function installNetworkTokenCapture() {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    try {
      const [input, init] = args;
      const url = typeof input === "string" ? input : input?.url;
      captureFromRequest(url, init?.headers);
    } catch {
      // Ignore capture errors; do not block app behavior.
    }
    return originalFetch(...args);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__captureUrl = typeof url === "string" ? url : "";
    this.__captureHeaders = {};
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (typeof name === "string" && typeof value === "string") {
        this.__captureHeaders[name.toLowerCase()] = value;
      }
    } catch {
      // Ignore.
    }
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      captureFromRequest(this.__captureUrl, this.__captureHeaders);
    } catch {
      // Ignore capture errors.
    }
    return originalSend.call(this, body);
  };
}

function captureFromRequest(url, headers) {
  if (!url || typeof url !== "string") return;
  const bearer = getBearerToken(headers);
  const normalizedUrl = url.toLowerCase();

  if (normalizedUrl.includes("/api/services/app/chat/authorizeanonymousasync")) {
    if (bearer) {
      druidRuntime.chatBearerToken = bearer;
      maybePromoteToGptToken(bearer);
    }
  }

  if (normalizedUrl.includes("/getstatus?")) {
    const statusUrl = getAbsoluteUrl(url);
    if (statusUrl) druidRuntime.getStatusUrl = statusUrl;
    const conversationFromQuery = getQueryParam(statusUrl || url, "ConversationId");
    if (isLikelyConversationId(conversationFromQuery)) {
      druidRuntime.conversationId = conversationFromQuery;
    }
    if (bearer) {
      druidRuntime.chatBearerToken = bearer;
      maybePromoteToGptToken(bearer);
    }
  }

  const match = url.match(/\/directline\/conversations\/([^/]+)\/activities/i);
  if (match?.[1]) {
    const candidateConversationId = decodeURIComponent(match[1]);
    if (isLikelyConversationId(candidateConversationId)) {
      druidRuntime.conversationId = candidateConversationId;
    }
    if (bearer) {
      druidRuntime.directLineToken = bearer;
      maybePromoteToGptToken(bearer);
    }
  }

  if (normalizedUrl.includes("/openai/deployments/")) {
    if (bearer) {
      druidRuntime.gptBearerToken = bearer;
    }
  }
}

function getBearerToken(headers) {
  const authValue = readHeader(headers, "authorization");
  if (!authValue || typeof authValue !== "string") return null;
  const match = authValue.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return null;
  return match[1].trim();
}

function readHeader(headers, key) {
  if (!headers) return null;
  const lowerKey = key.toLowerCase();

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(key) || headers.get(lowerKey);
  }

  if (Array.isArray(headers)) {
    const hit = headers.find(
      (entry) =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        entry[0].toLowerCase() === lowerKey
    );
    return hit ? hit[1] : null;
  }

  if (typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (typeof k === "string" && k.toLowerCase() === lowerKey) {
        return typeof v === "string" ? v : null;
      }
    }
  }

  return null;
}

function getAbsoluteUrl(url) {
  try {
    return new URL(url, window.location.href).toString();
  } catch {
    return null;
  }
}

function getQueryParam(url, key) {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.searchParams.get(key);
  } catch {
    return null;
  }
}

function isLikelyConversationId(value) {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 10) return false;
  if (!trimmed.includes("-")) return false;
  return /^[A-Za-z0-9._|-]+$/.test(trimmed);
}

function maybePromoteToGptToken(token) {
  if (!token || typeof token !== "string") return;
  if (!isLikelyLlmToken(token)) return;
  if (druidRuntime.gptBearerToken === token) return;
  druidRuntime.gptBearerToken = token;
}

function isLikelyLlmToken(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return false;
    const payloadJson = base64UrlDecode(parts[1]);
    const payload = JSON.parse(payloadJson);
    const aud = typeof payload?.aud === "string" ? payload.aud.trim() : "";
    const llmClaims =
      typeof payload?.["Druid.LLM.UserClaims"] === "string"
        ? payload["Druid.LLM.UserClaims"].trim()
        : "";
    const iss = typeof payload?.iss === "string" ? payload.iss.trim() : "";
    return aud === "Druid.LLM" || !!llmClaims || iss === "Druid AI";
  } catch {
    return false;
  }
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad ? normalized + "=".repeat(4 - pad) : normalized;
  return atob(padded);
}

function getCurrentFormState() {
  return {
    name: formFields.name.value || null,
    email: formFields.email.value || null,
    dob: formFields.dob.value || null,
    gender: getCheckedValue("gender"),
    relationshipStatus: getCheckedValue("relationshipStatus"),
    creditCard: getCheckedValue("creditCard")
  };
}

function applyExtractedFields(extracted) {
  if (extracted.name) formFields.name.value = extracted.name;
  if (extracted.email) formFields.email.value = extracted.email;
  if (extracted.dob) formFields.dob.value = extracted.dob;

  if (extracted.gender) {
    const genderInput = document.querySelector(`input[name="gender"][value="${extracted.gender}"]`);
    if (genderInput) genderInput.checked = true;
  }

  if (extracted.relationshipStatus) {
    const relationInput = document.querySelector(
      `input[name="relationshipStatus"][value="${extracted.relationshipStatus}"]`
    );
    if (relationInput) relationInput.checked = true;
  }

  if (extracted.creditCard) {
    const creditCardInput = document.querySelector(
      `input[name="creditCard"][value="${extracted.creditCard}"]`
    );
    if (creditCardInput) {
      creditCardInput.checked = true;
    }
  }
}

function getCheckedValue(name) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : null;
}

function applyUploadedImages(images) {
  if (!uploadedImagePreview || !uploadedImageHint) return;
  if (!Array.isArray(images) || !images.length) {
    return;
  }

  const latest = images[images.length - 1];
  const imageUrl = normalizeImageDataUrl(latest?.dataUrl);
  if (!imageUrl) return;

  const activityId = normalizeString(latest?.activityId);
  if (activityId && activityId === lastRenderedImageActivityId) return;

  uploadedImagePreview.src = imageUrl;
  uploadedImagePreview.hidden = false;
  uploadedImageHint.hidden = true;
  lastRenderedImageActivityId = activityId || imageUrl;
}

function normalizeImageDataUrl(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (/^data:image\//i.test(normalized)) return normalized;
  if (/^https?:\/\/\S+/i.test(normalized)) return normalized;
  return null;
}

function normalizeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function applyImageExtraction(extraction) {
  if (!ocrNameField || !ocrPassportIdField) return;
  const name = normalizeString(extraction?.name);
  const passportId = normalizeString(extraction?.passportId);
  ocrNameField.value = name || "";
  ocrPassportIdField.value = passportId || "";
}
