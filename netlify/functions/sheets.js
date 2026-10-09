exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const id = p.id, sheet = p.sheet, url = p.url;
  let target;
  if (url) {
    try {
      const u = new URL(url);
      if (!/(^|\.)docs\.google\.com$/.test(u.hostname) && !/(^|\.)googleusercontent\.com$/.test(u.hostname))
        return { statusCode: 400, body: "bad url host" };
      target = url;
    } catch (e) { return { statusCode: 400, body: "bad url" }; }
  } else if (id) {
    /* headers=1 or Google guesses how many rows of the sheet are headings - for DB_Games
       it guesses three, and the first two fixtures of the season never arrive. */
    target = "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(id) +
             "/gviz/tq?tqx=out:csv&headers=1" + (sheet ? "&sheet=" + encodeURIComponent(sheet) : "");
  } else {
    return { statusCode: 400, body: "missing id or url" };
  }
  try {
    const r = await fetch(target, { redirect: "follow" });
    const t = await r.text();
    return { statusCode: r.status, headers: { "content-type": "text/csv; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" }, body: t };
  } catch (e) {
    return { statusCode: 502, body: "err " + (e && e.message) };
  }
};
