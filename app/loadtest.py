"""SesTemiz yük testi: hız, trafik (100-400 eşzamanlı kullanıcı) ve stres (100 eşzamanlı model isteği).

Yalnızca standart kütüphane kullanır. Önce sunucuyu başlat (`python -m app.server`), sonra:
    python -m app.loadtest                      # http://localhost:8080
    python -m app.loadtest --url http://host:port
Model isteği yapan bölümler GPU/CPU'yu birkaç saniye meşgul eder; canlı bir sunucuya karşı çalıştırma.
"""
import http.client
import json
import statistics as st
import argparse
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://localhost:8080"
PAGE = ["/", "/css/style.css", "/js/i18n.js", "/js/dsp.js", "/js/app.js", "/js/tour.js",
        "/samples/tr/denemeler.json", "/samples/gercek/kayitlar.json"]
AUDIO = ["/samples/snr%2B0_hen_noisy.wav", "/samples/snr%2B0_hen_clean.wav"]
WAV = (ROOT / "samples/tr/snr+0_hen_01_hava_noisy.wav").read_bytes()


def get(path, gzip=True):
    req = urllib.request.Request(BASE + path, headers={"Accept-Encoding": "gzip"} if gzip else {})
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
            return time.perf_counter() - t, r.status, len(body)
    except Exception as e:  # noqa: BLE001
        return time.perf_counter() - t, repr(e)[:60], 0


def post(model="e3_depth5"):
    req = urllib.request.Request(f"{BASE}/api/enhance?model={model}&ref=tr/snr%2B0_hen_01_hava", data=WAV,
                                 headers={"Content-Type": "audio/wav"}, method="POST")
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            body = r.read()
            ok = body[:4] == b"RIFF" and json.loads(r.headers["X-Metrics"]) is not None
            return time.perf_counter() - t, r.status if ok else "bad-body", len(body)
    except Exception as e:  # noqa: BLE001
        return time.perf_counter() - t, repr(e)[:60], 0


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def report(name, res, wall):
    lat = [r[0] * 1000 for r in res]
    errs = [r[1] for r in res if r[1] != 200]
    mb = sum(r[2] for r in res) / 1e6
    print(f"{name}: {len(res)} istek, {wall:.2f} sn, {len(res) / wall:.0f} istek/sn, {mb:.1f} MB | "
          f"p50 {pct(lat, 50):.0f} ms, p95 {pct(lat, 95):.0f} ms, maks {max(lat):.0f} ms | "
          f"hata {len(errs)}" + (f" {sorted(set(map(str, errs)))[:3]}" if errs else ""))
    return lat, errs


def user_visit():
    """Bir kullanıcının ilk ziyareti: sayfa + varlıklar + bir örnek ses, tarayıcı gibi tek bağlantı üzerinden
    (sunucu keep-alive desteklemiyorsa http.client her istekte yeniden bağlanır)."""
    host = urlparse(BASE)
    conn = http.client.HTTPConnection(host.hostname, host.port, timeout=120)
    out = []
    for p in PAGE + AUDIO:
        t = time.perf_counter()
        try:
            conn.request("GET", p, headers={"Accept-Encoding": "gzip"} if p in PAGE else {})
            r = conn.getresponse()
            body = r.read()
            out.append((time.perf_counter() - t, r.status, len(body)))
        except Exception as e:  # noqa: BLE001
            conn.close()
            out.append((time.perf_counter() - t, repr(e)[:60], 0))
    conn.close()
    return out


def concurrent(n, fn, rounds=1):
    t = time.perf_counter()
    with ThreadPoolExecutor(n) as ex:
        out = list(ex.map(lambda _: fn(), range(n * rounds)))
    return out, time.perf_counter() - t


def main() -> None:
    global BASE
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default=BASE, help="sunucu adresi")
    BASE = ap.parse_args().url.rstrip("/")

    print("== 1) HIZ: tek kullanıcı, her dosya 20 kez ==")
    for p in PAGE + AUDIO:
        res = [get(p, gzip=not p.endswith((".wav", ".png"))) for _ in range(20)]
        lat = [r[0] * 1000 for r in res]
        print(f"  {p:34s} {res[0][2] / 1024:7.1f} KB  ort {st.mean(lat):5.1f} ms  p95 {pct(lat, 95):5.1f} ms")
    lat1 = [post()[0] * 1000 for _ in range(5)]
    print(f"  POST /api/enhance (4.8 sn ses)      ort {st.mean(lat1):5.0f} ms  (5 deneme, ısınmış)")

    print("\n== 2) TRAFİK: eşzamanlı kullanıcılar sayfayı açıyor (her biri 10 dosya) ==")
    for n in (100, 200, 400):
        out, wall = concurrent(n, user_visit, rounds=2)
        flat = [r for visit in out for r in visit]
        report(f"  {n} kullanıcı x2 ziyaret", flat, wall)
        visits = [sum(r[0] for r in v) * 1000 for v in out]
        print(f"     bir ziyaretin toplam süresi: p50 {pct(visits, 50):.0f} ms, p95 {pct(visits, 95):.0f} ms")

    print("\n== 3) STRES: 100 kullanıcı aynı anda 'Temizle'ye basıyor ==")
    out, wall = concurrent(100, post)
    lat, errs = report("  100 eşzamanlı /api/enhance", out, wall)
    print(f"     ilk yanıt {min(lat) / 1000:.1f} sn, en son yanıt {max(lat) / 1000:.1f} sn, "
          f"istek başına model süresi ~{wall / 100 * 1000:.0f} ms")

    print("\n== 4) KARIŞIK: 100 sayfa ziyareti + 20 model isteği aynı anda ==")
    t = time.perf_counter()
    with ThreadPoolExecutor(120) as ex:
        fs = [ex.submit(user_visit) for _ in range(100)] + [ex.submit(post) for _ in range(20)]
        res = [f.result() for f in fs]
    wall = time.perf_counter() - t
    pages = [r for v in res[:100] for r in v]
    report("  statik dosyalar (model kuyruğu doluyken)", pages, wall)
    report("  model istekleri", res[100:], wall)
    print("\n" + json.dumps(json.loads(urllib.request.urlopen(BASE + "/api/status").read())))


if __name__ == "__main__":
    main()
