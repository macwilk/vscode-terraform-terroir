variable "bucket" {
  default = "{{ os.environ['CAPITALRX_ENVIRONMENT_PREFIX'] -}}artifacts"
}

variable "region" {
{% if is_enabled("fixture.enabled") %}
default   = "us-east-1"
{% else %}
default = "us-west-2"
{% endif %}
}
