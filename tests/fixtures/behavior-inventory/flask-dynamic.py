from flask import Flask, jsonify

app = Flask(__name__)

RULES = ["/dynamic/<item_id>", "/dynamic/<item_id>/history"]


def make_view(rule):
    def view(item_id):
        return jsonify({"rule": rule, "item_id": item_id})

    return view


for rule in RULES:
    endpoint = "view_" + rule.strip("/").replace("/", "_").replace("<", "").replace(">", "")
    app.add_url_rule(rule, endpoint, make_view(rule))
