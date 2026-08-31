"""Stand-in for the 3.11+ stdlib module, for older interpreters."""

from tomli import TOMLDecodeError, load, loads

__all__ = ['TOMLDecodeError', 'load', 'loads']
