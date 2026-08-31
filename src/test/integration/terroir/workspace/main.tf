resource "aws_s3_bucket" "example" {
  bucket = var.bucket
{% if is_enabled("fixture.disabled") %}
  acl = "private"
{% endif %}
{% if is_enabled("fixture.typo") %}
  tags = {}
{% endif %}
}
