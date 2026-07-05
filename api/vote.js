const STATE_KEY = "icecream:state";
const RESULT_TTL_SECONDS = 30;

function freshState() {
  return {
    playerA: { voted: false },
    playerB: { voted: false },
    revealed: false,
  };
}

/*
  Atomic vote script.

  KEYS[1] = icecream:state

  ARGV[1] = player ("A" / "B")
  ARGV[2] = choice ("yes" / "no")
  ARGV[3] = new roundId
*/
const VOTE_LUA_SCRIPT = `
local rawState = redis.call("GET", KEYS[1])

local state

if rawState then
  state = cjson.decode(rawState)
else
  state = {
    playerA = { voted = false },
    playerB = { voted = false },
    revealed = false,
    roundId = ARGV[3]
  }
end

-- Backward-compatible fallback if old state exists without roundId.
if not state.roundId then
  state.roundId = ARGV[3]
end

-- Defensive safety in case Redis state is incomplete.
if not state.playerA then
  state.playerA = { voted = false }
end

if not state.playerB then
  state.playerB = { voted = false }
end

if state.revealed == nil then
  state.revealed = false
end

local player = ARGV[1]
local choice = ARGV[2]

local playerKey

if player == "A" then
  playerKey = "playerA"
else
  playerKey = "playerB"
end

-- Once a result has been revealed, no more votes are allowed.
if state.revealed == true then
  return cjson.encode({
    ok = false,
    code = "ROUND_REVEALED",
    state = state
  })
end

-- One player can only vote once per round.
if state[playerKey].voted == true then
  return cjson.encode({
    ok = false,
    code = "ALREADY_VOTED",
    state = state
  })
end

-- Save the vote.
state[playerKey].voted = true
state[playerKey].choice = choice

local bothVoted =
  state.playerA.voted == true
  and state.playerB.voted == true

if bothVoted then
  state.revealed = true

  if state.playerA.choice == "yes"
    and state.playerB.choice == "yes" then
    state.result = "yes"
  else
    state.result = "no"
  end

  -- Show result for 30 seconds, then Redis deletes this key automatically.
  redis.call(
    "SET",
    KEYS[1],
    cjson.encode(state),
    "EX",
    ${RESULT_TTL_SECONDS}
  )

  return cjson.encode({
    ok = true,
    justRevealed = true,
    state = state
  })
end

-- Only one player has voted: persist state without expiry.
redis.call("SET", KEYS[1], cjson.encode(state))

return cjson.encode({
  ok = true,
  justRevealed = false,
  state = state
})
`;

export default async function handler(request, response) {
  if (!response) {
    return handleVoteRequest(request);
  }

  const webRequest = await nodeRequestToWebRequest(request);
  const webResponse = await handleVoteRequest(webRequest);

  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });

  response.end(await webResponse.text());
}

export async function handleVoteRequest(request) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
  };

  try {
    ensureEnvironmentVariables();

    // GET /api/vote
    if (request.method === "GET") {
      const state = await getCurrentState();

      return jsonResponse(state, 200, headers);
    }

    // POST /api/vote
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
      const choice = body?.choice;

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

      if (choice !== "yes" && choice !== "no") {
        return jsonResponse(
          {
            error: 'Invalid choice. Use "yes" or "no".',
            code: "INVALID_CHOICE",
          },
          400,
          headers
        );
      }

      const result = await castVoteAtomically({
        player,
        choice,
        roundId: createRoundId(),
      });

      if (!result?.ok) {
        const isAlreadyVoted = result?.code === "ALREADY_VOTED";

        return jsonResponse(
          {
            error: isAlreadyVoted
              ? "You have already voted in this round."
              : "This round has already been revealed.",
            code: result?.code || "VOTE_REJECTED",
            state: result?.state || null,
          },
          409,
          headers
        );
      }

      return jsonResponse(
        {
          state: result.state,
          justRevealed: result.justRevealed === true,
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
    console.error("Ice Cream Council API error:", error);

    return jsonResponse(
      {
        error: "The Ice Cream Council had a technical meltdown.",
        code: "SERVER_ERROR",
      },
      500,
      headers
    );
  }
}

/* ---------------------------------------
   GET CURRENT REDIS STATE
---------------------------------------- */

async function getCurrentState() {
  const redisUrl = getRedisUrl();

  const response = await fetch(
    `${redisUrl}/get/${encodeURIComponent(STATE_KEY)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      },
    }
  );

  const payload = await safeJson(response);

  if (!response.ok || payload?.error) {
    throw new Error(
      payload?.error ||
        `Upstash GET failed with status ${response.status}`
    );
  }

  // Key does not exist yet, or it expired after 30 seconds.
  if (!payload?.result) {
    return freshState();
  }

  try {
    return JSON.parse(payload.result);
  } catch {
    throw new Error("Redis contains invalid vote state data.");
  }
}

/* ---------------------------------------
   ATOMIC REDIS EVAL
---------------------------------------- */

async function castVoteAtomically({ player, choice, roundId }) {
  const redisResponse = await runUpstashCommand([
    "EVAL",
    VOTE_LUA_SCRIPT,
    1,
    STATE_KEY,
    player,
    choice,
    roundId,
  ]);

  if (typeof redisResponse !== "string") {
    throw new Error("Unexpected Redis EVAL response.");
  }

  try {
    return JSON.parse(redisResponse);
  } catch {
    throw new Error("Redis returned invalid vote data.");
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
    throw new Error(
      payload?.error ||
        `Upstash command failed with status ${response.status}`
    );
  }

  return payload.result;
}

/* ---------------------------------------
   HELPERS
---------------------------------------- */

function ensureEnvironmentVariables() {
  if (
    !process.env.UPSTASH_REDIS_REST_URL ||
    !process.env.UPSTASH_REDIS_REST_TOKEN
  ) {
    throw new Error(
      "Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN."
    );
  }
}

function getRedisUrl() {
  return process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, "");
}

function createRoundId() {
  const randomPart =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 10)}`;

  return `icecream-${Date.now()}-${randomPart}`;
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

async function nodeRequestToWebRequest(request) {
  const protocol = request.headers["x-forwarded-proto"] || "http";
  const host = request.headers.host || "localhost";
  const url = new URL(request.url || "/api/vote", `${protocol}://${host}`);
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
