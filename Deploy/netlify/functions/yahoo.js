"use strict";

var HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];

exports.handler = async function (event) {
  var params = Object.assign({}, event.queryStringParameters || {});
  var path = String(params.path || "").replace(/^\/+/, "");
  delete params.path;
  if (!/^v[18]\/finance\/(?:chart|search)\//.test(path) && !/^v1\/finance\/search$/.test(path)) {
    return { statusCode: 400, body: "Unsupported market-data path" };
  }
  var query = new URLSearchParams(params).toString();
  for (var i = 0; i < HOSTS.length; i++) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 9000);
    try {
      var response = await fetch(HOSTS[i] + "/" + path + (query ? "?" + query : ""), {
        signal: controller.signal,
        headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0 Valutio/1.0" },
      });
      clearTimeout(timer);
      if (!response.ok) continue;
      var body = await response.text();
      JSON.parse(body);
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        body: body,
      };
    } catch (error) { clearTimeout(timer); }
  }
  return { statusCode: 502, headers: { "Cache-Control": "no-store" }, body: "Market provider unavailable" };
};
