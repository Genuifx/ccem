#!/usr/bin/env ruby

require 'psych'

def walk_yaml(node, file, errors)
  case node
  when Psych::Nodes::Document
    walk_yaml(node.root, file, errors)
  when Psych::Nodes::Mapping
    seen = {}
    node.children.each_slice(2) do |key_node, value_node|
      if key_node.is_a?(Psych::Nodes::Scalar)
        key = key_node.value
        if seen.key?(key)
          errors << "#{file}:#{key_node.start_line + 1}: duplicate YAML key #{key.inspect}"
        else
          seen[key] = key_node.start_line
        end
      end
      walk_yaml(value_node, file, errors)
    end
  when Psych::Nodes::Sequence
    node.children.each { |child| walk_yaml(child, file, errors) }
  end
end

if ARGV.empty?
  warn 'Usage: ruby scripts/ci/check-yaml-duplicate-keys.rb <file.yml> [...]'
  exit 2
end

errors = []
ARGV.each do |file|
  begin
    walk_yaml(Psych.parse_file(file), file, errors)
  rescue Psych::SyntaxError => error
    errors << "#{file}:#{error.line}: invalid YAML: #{error.problem}"
  end
end

unless errors.empty?
  warn errors.join("\n")
  exit 1
end

puts "YAML duplicate-key check passed: #{ARGV.length} file(s)"
