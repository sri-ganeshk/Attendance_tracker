import os

S3_BUCKET   = os.environ.get("ZAPPA_S3_BUCKET")
ROLE_ARN    = os.environ.get("ZAPPA_ROLE_ARN")
AWS_PROFILE = os.environ.get("AWS_PROFILE")
AWS_REGION  = os.environ["AWS_REGION"]

BASE = {
    "app_function": "app.app",
    "aws_region": AWS_REGION,
    "exclude": ["boto3", "dateutil", "botocore", "s3transfer", "concurrent"],
    "profile_name": AWS_PROFILE,
    "project_name": "api",
    "runtime": "python3.12",
    "s3_bucket": S3_BUCKET,
    "role_arn": ROLE_ARN,
}


ZAPPA_SETTINGS = {
    "dev": BASE,
    "dev_ap_east_1":      {**BASE, "aws_region": "ap-east-1"},
    "dev_ap_northeast_1": {**BASE, "aws_region": "ap-northeast-1"},
    "dev_ap_northeast_2": {**BASE, "aws_region": "ap-northeast-2"},
    "dev_ap_northeast_3": {**BASE, "aws_region": "ap-northeast-3"},
    "dev_ap_south_1":     {**BASE, "aws_region": "ap-south-1"},
    "dev_ap_southeast_1": {**BASE, "aws_region": "ap-southeast-1"},
    "dev_ca_central_1":   {**BASE, "aws_region": "ca-central-1"},
    "dev_eu_central_1":   {**BASE, "aws_region": "eu-central-1"},
    "dev_eu_north_1":     {**BASE, "aws_region": "eu-north-1"},
    "dev_eu_west_1":      {**BASE, "aws_region": "eu-west-1"},
    "dev_eu_west_2":      {**BASE, "aws_region": "eu-west-2"},
    "dev_eu_west_3":      {**BASE, "aws_region": "eu-west-3"},
    "dev_sa_east_1":      {**BASE, "aws_region": "sa-east-1"},
    "dev_us_east_1":      {**BASE, "aws_region": "us-east-1"},
    "dev_us_east_2":      {**BASE, "aws_region": "us-east-2"},
    "dev_us_west_1":      {**BASE, "aws_region": "us-west-1"},
    "dev_us_west_2":      {**BASE, "aws_region": "us-west-2"},
}
