import json
import time
from pathlib import Path
from DrissionPage import ChromiumPage, ChromiumOptions

def summarise(caps):
    real = {}
    for cap in caps:
        sec = cap.get("secret")
        if not sec or not isinstance(sec, str):
            continue
        ver = cap.get("version") or cap.get("obj", {}).get("version")
        if ver and ver != 0:
            real[str(int(ver))] = sec
    
    if not real:
        return False, "No secrets found."
    
    versions = sorted(int(k) for k in real.keys())
    secret_bytes = [
        {"version": v, "secret": [ord(c) for c in real[str(v)]]}
        for v in versions
    ]
    
    secrets_dir = Path.home() / ".spotify-secret"
    secrets_dir.mkdir(exist_ok=True)
    
    output_file = secrets_dir / "secretBytes.json"
    with open(output_file, "w") as f:
        json.dump(secret_bytes, f, indent=2)
    
    return True, f"Saved to: {output_file}"

def grab_live(progress_callback=None):
    def emit_progress(msg):
        if progress_callback:
            progress_callback(msg)
        else:
            print(msg)
    
    stealth = """(()=>{
        Object.defineProperty(navigator,'webdriver',{get:()=>false});
        Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
        Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
        window.chrome={runtime:{}};
        const q=navigator.permissions.query;
        navigator.permissions.query=p=>p.name==='notifications'?Promise.resolve({state:Notification.permission}):q(p);
        const g=WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter=function(p){
            if(p===37445)return'Intel Inc.';if(p===37446)return'Intel Iris OpenGL Engine';return g.call(this,p);
        };
    })();"""
    
    hook = """(()=>{if(globalThis.__secretHookInstalled)return;
    globalThis.__secretHookInstalled=true;globalThis.__captures=[];
    Object.defineProperty(Object.prototype,'secret',{configurable:true,set:function(v){
        try{__captures.push({secret:v,version:this.version,obj:this});}catch(e){}
        Object.defineProperty(this,'secret',{value:v,writable:true,configurable:true,enumerable:true});}});
    })();"""
    
    co = ChromiumOptions()
    co.headless(True)
    co.set_argument('--disable-blink-features=AutomationControlled')
    co.set_argument('--no-sandbox')
    
    page = ChromiumPage(addr_or_opts=co)
    try:
        page.run_cdp('Page.addScriptToEvaluateOnNewDocument', source=stealth)
        page.run_cdp('Page.addScriptToEvaluateOnNewDocument', source=hook)
        emit_progress("Opening Spotify...")
        page.get("https://open.spotify.com")
        time.sleep(3)
        caps = page.run_js("return globalThis.__captures || []")
        for c in caps:
            if isinstance(c, dict) and c.get("secret") and c.get("version"):
                emit_progress(f"Secret({int(c['version'])}): {c['secret']}")
        return caps or []
    finally:
        page.quit()

def scrape_and_save(progress_callback=None):
    try:
        caps = grab_live(progress_callback)
        return summarise(caps)
    except Exception as e:
        return False, f"Error: {str(e)}"

def main():
    success, message = scrape_and_save()
    print(message)
    return 0 if success else 1

if __name__ == "__main__":
    import sys
    sys.exit(main())