This is a temporary hack to delete broken windows instances.

"Broken" is defined as being in an "impaired" state according to the EC2 status
checks.

The script requires AWS credentials in environment variables or, barring that,
attempts to fetch them from the secrets store via the taskcluster-proxy.
