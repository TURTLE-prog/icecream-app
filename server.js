import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import playerHandler from "./api/player.js";
import voteHandler from "./api/vote.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3000);

await loadLocalEnv(path.join(__dirname, ".env.local"));

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);

    if (requestUrl.pathname === "/api/vote") {
      await voteHandler(request, response);
      return;
    }

    if (requestUrl.pathname === "/api/player") {
      await playerHandler(request, response);
      return;
    }

    await serveStaticFile(requestUrl.pathname, response);
  } catch (error) {
    console.error("Local server error:", error);
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("The local server hit an error.");
  }
});

server.listen(port, () => {
  console.log(`Ice Cream Council is running at http://localhost:${port}`);
});

async function serveStaticFile(urlPathname, response) {
  const normalizedPath = path.normalize(decodeURIComponent(urlPathname));
  const relativePath = normalizedPath === path.sep ? "index.html" : normalizedPath.slice(1);
  const filePath = path.join(publicDir, relativePath);

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": getContentType(filePath),
    "Cache-Control": "no-store",
  });

  createReadStream(filePath).pipe(response);
}

async function loadLocalEnv(filePath) {
  if (!existsSync(filePath)) return;

  const contents = await readFile(filePath, "utf8");

  for (const line of contents.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) continue;

    const equalsIndex = trimmedLine.indexOf("=");

    if (equalsIndex === -1) continue;

    const key = trimmedLine.slice(0, equalsIndex).trim();
    const value = trimmedLine.slice(equalsIndex + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  }[extension] || "application/octet-stream";
}
