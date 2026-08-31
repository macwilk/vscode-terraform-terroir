import json
import os


class Plugin:
    config = None

    def __init__(self):
        with open(os.path.join(os.path.dirname(__file__), "settings.json")) as fp:
            self.config = json.loads(fp.read())

    def update_template_variables(self, template_variables, tf_file=None):
        self.original_template_variables = template_variables
        template_variables.update({"is_enabled": self.is_enabled})

    def is_enabled(self, setting):
        env = self.original_template_variables["os"].environ["CAPITALRX_ENVIRONMENT"]
        value = self.config.get(setting)
        if not value:
            return False
        value.append("test")
        return env in value
