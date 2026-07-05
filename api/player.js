const PLAYER_KEY = "icecream:players";

const CLAIM_PLAYER_LUA_SCRIPT = `
local rawPlayers = redis.call("GET", KEYS[1])
local players

if rawPlayers then
  players = cjson.decode(rawPlayers)
else
  players = {}
end

if not players.A then
  players.A = false
end

if not players.B then
  players.B = false
end

local requestedPlayer = ARGV[1]
local deviceId = ARGV[2]

local otherPlayer = "B"

if requestedPlayer == "B" then
  otherPlayer = "A"
end

if players[requestedPlayer] == deviceId then
  return cjson.encode({
    ok = true,
    player = requestedPlayer,
    players = players
  })
end

if players[otherPlayer] == deviceId then
  return cjson.encode({
    ok = false,
    code = "DEVICE_ALREADY_ASSIGNED",
    player = otherPlayer,
    players = players
  })
end

if players[requestedPlayer] ~= false then
  return cjson.encode({
    ok = false,
    code = "PLAYER_TAKEN",
    players = players
  })
end

players[requestedPlayer] = deviceId
redis.call("SET", KEYS[1], cjson.encode(players))

return cjson.encode({
  ok = true,
  player = requestedPlayer,
  players = players
})
`;

export default async function handler(request, response) {
  if (!response) {
    return handlePlayerRequest(request);
  }

  const webRequest = await nodeRequestToWebRequest(request);
  const webResponse = await handlePlayerRequest(webRequest);

  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });

  response.end(await webResponse.text());
}

export async function handlePlayerRequest(request) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
  };

  try {
    ensureEnvironmentVariables();

    if (request.method === "GET") {
      const players = await getPlayers();

      return jsonResponse(toPublicPlayers(players), 200, headers);
    }

    if (request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return jsonResponse(
          {
            error: "Invalid JSON request body.",
            code: "INVALID_JSON",
          },
          400,
          headers
        );
      }

      const player = body?.player;
      const deviceId = cleanDeviceId(body?.deviceId);

      if (player !== "A" && player !== "B") {
        return jsonResponse(
          {
            error: 'Invalid player. Use "A" or "B".',
            code: "INVALID_PLAYER",
          },
          400,
          headers
        );
      }

      if (!deviceId) {
        return jsonResponse(
          {
            error: "Missing device identity.",
            code: "INVALID_DEVICE",
          },
          400,
          headers
        );
      }

      const result = await claimPlayerAtomically(player, deviceId);

      if (!result?.ok) {
        const alreadyAssigned = result?.code === "DEVICE_ALREADY_ASSIGNED";

        return jsonResponse(
          {
            error: alreadyAssigned
              ? `This device is already locked to Player ${result.player}.`
              : `Player ${player} is already taken.`,
            code: result?.code || "PLAYER_CLAIM_REJECTED",
            player: result?.player || null,
            players: toPublicPlayers(result?.players || {}),
          },
          409,
          headers
        );
      }

      return jsonResponse(
        {
          player: result.player,
          players: toPublicPlayers(result.players),
        },
        200,
        headers
      );
    }

    return jsonResponse(
      {
        error: "Method not allowed. Use GET or POST.",
      },
      405,
      {
        ...headers,
        Allow: "GET, POST",
      }
    );
  } catch (error) {
    console.error("Ice Cream Council player API error:", error);

    if (error instanceof AppError) {
      return jsonResponse(
        {
          error: error.publicMessage,
          code: error.code,
          missing: error.missing,
          status: error.status,
        },
        error.httpStatus,
        headers
      );
    }

    return jsonResponse(
      {
        error: "The player seats could not be checked.",
        code: "SERVER_ERROR",
      },
      500,
      headers
    );
  }
}

async function getPlayers() {
  const response = await fetch(
    `${getRedisUrl()}/get/${encodeURIComponent(PLAYER_KEY)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      },
    }
  );

  const payload = await safeJson(response);

  if (!response.ok || payload?.error) {
    throw new AppError({
      code: "UPSTASH_REQUEST_FAILED",
      publicMessage: "Upstash rejected the player-seat request.",
      httpStatus: 502,
      status: response.status,
    });
  }

  if (!payload?.result) {
    return {};
  }

  try {
    return JSON.parse(payload.result);
  } catch {
    throw new Error("Redis contains invalid player claim data.");
  }
}

async function claimPlayerAtomically(player, deviceId) {
  const redisResponse = await runUpstashCommand([
    "EVAL",
    CLAIM_PLAYER_LUA_SCRIPT,
    1,
    PLAYER_KEY,
    player,
    deviceId,
  ]);

  if (typeof redisResponse !== "string") {
    throw new Error("Unexpected Redis EVAL response.");
  }

  try {
    return JSON.parse(redisResponse);
  } catch {
    throw new Error("Redis returned invalid player claim data.");
  }
}

async function runUpstashCommand(command) {
  const response = await fetch(getRedisUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });

  const payload = await safeJson(response);

  if (!response.ok || payload?.error) {
    throw new AppError({
      code: "UPSTASH_REQUEST_FAILED",
      publicMessage: "Upstash rejected the player-seat request.",
      httpStatus: 502,
      status: response.status,
    });
  }

  return payload.result;
}

function toPublicPlayers(players = {}) {
  return {
    playerA: {
      claimed: Boolean(players.A),
    },
    playerB: {
      claimed: Boolean(players.B),
    },
  };
}

function cleanDeviceId(value) {
  const deviceId = String(value || "").trim();

  return deviceId.length >= 12 && deviceId.length <= 120
    ? deviceId
    : null;
}

function ensureEnvironmentVariables() {
  const missing = [
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ].filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new AppError({
      code: "MISSING_UPSTASH_ENV",
      publicMessage: "Missing required Upstash environment variables.",
      httpStatus: 500,
      missing,
    });
  }
}

function getRedisUrl() {
  return process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, "");
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function jsonResponse(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: extraHeaders,
  });
}

class AppError extends Error {
  constructor({
    code,
    publicMessage,
    httpStatus = 500,
    missing = undefined,
    status = undefined,
  }) {
    super(publicMessage);

    this.code = code;
    this.publicMessage = publicMessage;
    this.httpStatus = httpStatus;
    this.missing = missing;
    this.status = status;
  }
}

async function nodeRequestToWebRequest(request) {
  const protocol = request.headers["x-forwarded-proto"] || "http";
  const host = request.headers.host || "localhost";
  const url = new URL(request.url || "/api/player", `${protocol}://${host}`);
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers || {})) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(key, item));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const method = request.method || "GET";
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await readNodeRequestBody(request);

  return new Request(url, {
    method,
    headers,
    body,
  });
}

async function readNodeRequestBody(request) {
  if (request.body !== undefined) {
    return typeof request.body === "string"
      ? request.body
      : JSON.stringify(request.body);
  }

  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}
