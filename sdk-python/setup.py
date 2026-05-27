from setuptools import setup, find_packages

with open("README.md", "r", encoding="utf-8") as f:
    long_description = f.read()

setup(
    name="paylode-python",
    version="1.0.0",
    author="Paylode Services Limited",
    author_email="dev@paylodeservices.com",
    description="Official Python SDK for Paylode Services Limited — CBN Licensed PSSP",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/Gokeakinboro/Payment-Gateway",
    project_urls={
        "Documentation": "https://docs.paylodeservices.com",
        "Bug Tracker":   "https://github.com/Gokeakinboro/Payment-Gateway/issues",
    },
    packages=find_packages(exclude=["tests*"]),
    python_requires=">=3.7",
    install_requires=[],   # zero external dependencies — stdlib only
    classifiers=[
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.7",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Intended Audience :: Developers",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "Topic :: Office/Business :: Financial",
    ],
    keywords="paylode payments nigeria fintech cbn pssp payment-gateway",
)
