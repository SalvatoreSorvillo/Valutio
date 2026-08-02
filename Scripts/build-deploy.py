"""Build the deployable /app payload from the readable source.

The readable source folder stays the single source of truth. This script
copies the public app bundle to ../valutio-deploy/app:

  * app.js, app.i18n.js, statement-categorizer.js and app.css are minified for smaller downloads.
  * App-shell files and templates are copied verbatim.
  * Fonts and brand assets are copied so the deployed PWA works offline.

Release workflow:
  1. Edit code here in Valutio-source.
  2. BUMP the CACHE version string in sw.js (this is what triggers the in-app update prompt).
  3. py Scripts\\build-deploy.py
  4. Redeploy the valutio-deploy folder to Netlify.

Requires: py -m pip install rjsmin rcssmin
"""
import os, re, shutil, sys
try:
    import rjsmin, rcssmin
except ImportError:
    sys.exit("Missing dependency. Run:  pip install rjsmin rcssmin")

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEPLOY = os.path.abspath(os.path.join(SRC, "..", "valutio-deploy", "app"))
FILES = ["index.html", "sw.js", "manifest.webmanifest", "LICENSE"]
DIRS = ["Templates", "Icons", "Fonts", "Vendor", "Rules", "Deploy"]
def prepare_deploy_dir():
    """Recreate only the generated app payload before copying current files.

    The parent deploy folder also contains Netlify functions and website
    assets, so never remove it here. Rebuilding the app directory exactly
    prevents deleted source files from surviving in a later deployment.
    """
    deploy_name = os.path.basename(os.path.normpath(DEPLOY)).lower()
    parent_name = os.path.basename(os.path.dirname(os.path.normpath(DEPLOY))).lower()
    if deploy_name != "app" or parent_name != "valutio-deploy":
        sys.exit("Refusing to rebuild unexpected deploy path: " + DEPLOY)
    if os.path.isdir(DEPLOY):
        shutil.rmtree(DEPLOY)
    elif os.path.exists(DEPLOY):
        os.remove(DEPLOY)
    os.makedirs(DEPLOY, exist_ok=True)

def main():
    prepare_deploy_dir()
    src = open(os.path.join(SRC, "app.js"), encoding="utf-8").read()
    mini = rjsmin.jsmin(src)
    open(os.path.join(DEPLOY, "app.js"), "w", encoding="utf-8", newline="").write(mini)
    print("app.js  %d -> %d bytes (%.0f%% smaller, comments stripped)"
          % (len(src), len(mini), 100 * (1 - len(mini) / len(src))))
    i18n = open(os.path.join(SRC, "app.i18n.js"), encoding="utf-8").read()
    i18n_mini = rjsmin.jsmin(i18n)
    open(os.path.join(DEPLOY, "app.i18n.js"), "w", encoding="utf-8", newline="").write(i18n_mini)
    print("app.i18n.js %d -> %d bytes (%.0f%% smaller, comments stripped)"
          % (len(i18n), len(i18n_mini), 100 * (1 - len(i18n_mini) / len(i18n))))
    categorizer = open(os.path.join(SRC, "statement-categorizer.js"), encoding="utf-8").read()
    categorizer_mini = rjsmin.jsmin(categorizer)
    open(os.path.join(DEPLOY, "statement-categorizer.js"), "w", encoding="utf-8", newline="").write(categorizer_mini)
    print("statement-categorizer.js %d -> %d bytes (%.0f%% smaller, comments stripped)"
          % (len(categorizer), len(categorizer_mini), 100 * (1 - len(categorizer_mini) / len(categorizer))))
    css = open(os.path.join(SRC, "app.css"), encoding="utf-8").read()
    cmini = rcssmin.cssmin(css)
    open(os.path.join(DEPLOY, "app.css"), "w", encoding="utf-8", newline="").write(cmini)
    print("app.css %d -> %d bytes (%.0f%% smaller, comments stripped)"
          % (len(css), len(cmini), 100 * (1 - len(cmini) / len(css))))
    for f in FILES:
        shutil.copy2(os.path.join(SRC, f), os.path.join(DEPLOY, f))
    for d in DIRS:
        if d == "Deploy":
            shutil.copytree(os.path.join(SRC, d), os.path.dirname(DEPLOY), dirs_exist_ok=True)
        else:
            shutil.copytree(os.path.join(SRC, d), os.path.join(DEPLOY, d), dirs_exist_ok=True)
    sw = open(os.path.join(SRC, "sw.js"), encoding="utf-8").read()
    m = re.search(r'CACHE\s*=\s*"([^"]+)"', sw)
    print("copied app shell ->", DEPLOY)
    print("SW cache version:", m.group(1) if m else "?")
    print("Done. Now redeploy the valutio-deploy folder.")

if __name__ == "__main__":
    main()
