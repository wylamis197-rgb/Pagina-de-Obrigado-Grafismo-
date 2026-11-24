const FILE_ID = "1WFVsqpiuSnPRztWBn35gmE1-A3yvebJ1";
const DRIVE_URL = `https://drive.google.com/uc?export=download&id=${FILE_ID}`;

function getHiddenFields(form) {
  const fields = {};
  const inputs = form.match(/<input\\b[^>]*>/gi) || [];
  for (const input of inputs) {
    const type = (input.match(/type=["']([^"']+)["']/i) || [])[1];
    const name = (input.match(/name=["']([^"']+)["']/i) || [])[1];
    const value = (input.match(/value=["']([^"']*)["']/i) || [])[1];
    if (name && (!type || type.toLowerCase() === "hidden")) {
      fields[name] = value || "";
    }
  }
  return fields;
}

async function resolveDriveResponse(rangeHeader) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; VideoProxy/1.0)",
    ...(rangeHeader ? { Range: rangeHeader } : {})
  };

  let upstream = await fetch(DRIVE_URL, { headers, redirect: "follow" });
  const firstType = (upstream.headers.get("content-type") || "").toLowerCase();

  // Google may require an explicit confirmation form for some downloadable files.
  if (firstType.includes("text/html") && !upstream.url.includes("accounts.google.com")) {
    const html = await upstream.text();
    const formMatch = html.match(/<form\\b[^>]*>[\\s\\S]*?<\\/form>/i);
    if (formMatch) {
      const action = (formMatch[0].match(/action=["']([^"']+)["']/i) || [])[1];
      if (action) {
        const target = new URL(action, upstream.url);
        for (const [key, value] of Object.entries(getHiddenFields(formMatch[0]))) {
          target.searchParams.set(key, value);
        }
        const cookie = upstream.headers.get("set-cookie");
        upstream = await fetch(target, {
          headers: {
            ...headers,
            ...(cookie ? { Cookie: cookie.split(";")[0] } : {})
          },
          redirect: "follow"
        });
      }
    }
  }
  return upstream;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Método não permitido." });
  }

  const range = req.headers.range;
  let upstream;
  try {
    upstream = await resolveDriveResponse(range);
  } catch (error) {
    console.error("Falha ao acessar vídeo no Google Drive:", error);
    return res.status(502).json({ error: "Não foi possível acessar o vídeo no Google Drive." });
  }

  const type = (upstream.headers.get("content-type") || "").toLowerCase();
  const finalUrl = upstream.url || "";

  if (finalUrl.includes("accounts.google.com") || upstream.status === 401 || upstream.status === 403) {
    if (upstream.body) await upstream.body.cancel().catch(() => {});
    return res.status(403).json({
      error: "O vídeo está privado. No Google Drive, altere o acesso geral para 'Qualquer pessoa com o link' e a função para 'Leitor'."
    });
  }

  if (type.includes("text/html") || type.includes("application/json")) {
    if (upstream.body) await upstream.body.cancel().catch(() => {});
    return res.status(502).json({
      error: "O Google Drive não entregou o arquivo de vídeo. Confira o compartilhamento e se o vídeo já terminou de processar."
    });
  }

  if (!upstream.ok && upstream.status !== 206) {
    if (upstream.body) await upstream.body.cancel().catch(() => {});
    return res.status(upstream.status).json({ error: "O Google Drive não conseguiu fornecer o vídeo." });
  }

  res.statusCode = upstream.status;
  res.setHeader("Content-Type", type.includes("video/") ? (upstream.headers.get("content-type")) : "video/mp4");
  res.setHeader("Content-Disposition", 'inline; filename="apresentacao.mp4"');
  res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  res.setHeader("X-Content-Type-Options", "nosniff");

  for (const header of ["content-length", "content-range"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }

  if (req.method === "HEAD") {
    if (upstream.body) await upstream.body.cancel().catch(() => {});
    return res.end();
  }

  if (!upstream.body) return res.end();

  const reader = upstream.body.getReader();
  res.on("close", () => reader.cancel().catch(() => {}));

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise(resolve => res.once("drain", resolve));
      }
    }
    res.end();
  } catch (error) {
    console.error("Erro durante o envio do vídeo:", error);
    if (!res.headersSent) res.status(502);
    res.end();
  }
};
