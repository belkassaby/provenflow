import requests
import yaml


def load_settings(text):
    return yaml.load(text)


def fetch(url):
    return requests.get(url, verify=False)
