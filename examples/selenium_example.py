"""Selenium example.

    pip install selenium
    python examples/selenium_example.py https://example.app

Note: Selenium's execute_script needs a leading "return " to hand the value
back to Python. (CDP Runtime.evaluate and Playwright page.evaluate do not.)
"""

import json
import sys
import time

from selenium import webdriver

# Make `python/` importable, or just copy shadow_reach.py next to your code.
sys.path.insert(0, __file__.rsplit("/", 2)[0] + "/python")
from shadow_reach import scan_js, click_js, type_js, submit_js  # noqa: E402

url = sys.argv[1] if len(sys.argv) > 1 else "https://example.app"

driver = webdriver.Chrome()
try:
    driver.get(url)
    time.sleep(2)  # let the SPA render

    def run(js):
        return driver.execute_script("return " + js)

    interactables = json.loads(run(scan_js()))     # pierces shadow DOM
    for el in interactables:
        print(el["selector"], "->", el["text"][:40])

    run(click_js("text=New Post"))                  # durable label selector
    time.sleep(0.5)
    run(type_js("[contenteditable=true]", "hello mesh"))
    run(submit_js("form"))                          # fires the app's submit handler
finally:
    driver.quit()
