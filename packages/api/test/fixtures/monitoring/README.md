# Monitoring fixtures

These fixtures preserve the structure and relationships of captured service discovery output. Hostnames, domains, user names, account and tunnel identifiers, and host addresses are synthetic. Public domains use reserved example names. Tailnet, LAN, Docker, and loopback addresses keep their network classes so exposure tests still exercise the same cases.

When adding or refreshing a fixture, remove identifying values and credentials before committing it. Keep references consistent across fixtures and test expectations.
