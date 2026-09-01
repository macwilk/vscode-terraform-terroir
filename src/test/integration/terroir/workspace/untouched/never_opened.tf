variable "elsewhere" {
{% if is_enabled("fixture.enabled") %}
  default = "on"
{% else %}
  default = "off"
{% endif %}
}
